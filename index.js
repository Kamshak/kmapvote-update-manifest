var htmlparser = Promise = require('bluebird'),
  _ = require('lodash'),
  AWS = require('aws-sdk');

require('dotenv').load();

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
    exports.handler(null, {
        succeed: console.log.bind(console),
        fail: console.error.bind(console)
    });
}