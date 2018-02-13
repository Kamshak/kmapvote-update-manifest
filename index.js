var htmlparser = Promise = require('bluebird'),
  _ = require('lodash'),
  AWS = require('aws-sdk'),
  promisePipe = require('promisepipe'),
  pngquant = require('pngquant')
  fs = require('fs'),
  sharp = require('sharp'),
  streamifier = require('into-stream'),
  meter = require('stream-meter'),
  retry = require('bluebird-retry');

require('dotenv').load();

let Duplex = require('stream').Duplex;  
function bufferToStream(buffer) {  
  let stream = new Duplex();
  stream.push(buffer);
  stream.end(null);
  return stream;
}

AWS.config.update({region: process.env.AWS_REGION});

var s3 = new AWS.S3();
Promise.promisifyAll(s3);

function getAllKeys(marker) {
    var params = {
        Bucket: process.env.INPUT_BUCKET, /* required */
        Delimiter: '/',
        EncodingType: 'url',
        Prefix: process.env.INPUT_PREFIX,
        Marker: marker
    };
    
    return s3.listObjectsAsync(params).then(response => {
        if (response.IsTruncated) {
            return getAllKeys(response.NextMarker).then(contents => ([...response.Contents, ...contents]));
        }
        return response.Contents;
    }) 
}

function streamToBuffer(stream) {  
  return new Promise((resolve, reject) => {
    let buffers = [];
    stream.on('error', reject);
    stream.on('data', (data) => buffers.push(data));
    stream.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

function optimizePngs() {
  return getAllKeys()
    .then(function(data) {
      const icons = _(data).pluck('Key').map(function(key) {
        return decodeURIComponent(key.replace(process.env.INPUT_PREFIX, ""));
      }).toArray().value();
      console.log("Found", icons.length);
      return icons;
    }).map(async key => {
      let result;
      try {
        result = (await s3.getObjectAsync({
          Bucket: process.env.INPUT_BUCKET,
          Key: `mapicons/${key}`,
        }));
      } catch(e) {
        console.error(key, e);
        return false;
      }

      if (result.ContentType !== 'image/png') {
        console.log('skipping', key);
        return false;
      }

      const counter = meter();
      const quanter = new pngquant([192, '--quality', '60-80', '--nofs', '-']);
      try {
        await retry(() => promisePipe(
          streamifier(result.Body),
          sharp().png().toFormat('png'),
          quanter,
          counter,
          fs.createWriteStream('test/' + key)
        ), { interval: 0, max_tries: 3 });
  
        await s3.putObjectAsync({
          Bucket: process.env.OUTPUT_BUCKET,
          Key: 'mapicons-small/' + key,
          ACL: 'public-read',
          Body: fs.createReadStream('test/' + key)
        });
      } catch(e) {
        console.log(key, e);
      }
    }, { concurrency: 150 });
}

exports.handler = function(event, context) {
  var _mapCounts;

  getAllKeys()
  .then(function(data) {
    return _(data).pluck('Key').map(function(key) {
      return decodeURIComponent(key.replace(process.env.INPUT_PREFIX, ""));
    }).toArray().value();
  })
  .then(function(mapIcons) {
    return _(mapIcons).groupBy(function(val) {
      var match = val.match(/(.*?)(\(.*\))?.png/);
      if (!match) {
        return "INVALID";
      }
      return match[1];
    }).omit("INVALID").mapValues(_.property('length')).value();
  })
  .then(function(mapCounts) {
    _mapCounts = mapCounts
    var lua = "return {";
      _.forEach(mapCounts, function(v, k) {
        lua = lua + "\t['" + k + "']= " + v + ",\n";
      });
    lua = lua + "}";
    return lua;
  })
  .then(function(lua) {
    var params = {
      Bucket: process.env.OUTPUT_BUCKET, /* required */
      Key: process.env.OUTPUT_FILE, /* required */
      ACL: 'public-read',
      Body: lua,
    };
    return s3.putObjectAsync(params);
  })
  .then(function() {
    context.succeed(_mapCounts);
  }, function(e) {
    console.log(e);
    context.fail(JSON.stringify(e));
  });
}

if (require.main === module) {

  //optimizePngs().then(x => console.log("done"), e => console.error(e));
    exports.handler(null, {
        succeed: console.log.bind(console),
        fail: console.error.bind(console)
    });
}