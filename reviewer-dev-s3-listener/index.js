require('dotenv').config();
let config = {}

try {
  config = require("./config.json");
} catch (e) {
  // ok
}

function getEnvVar(name) {
  return process.env[name] || config[name];
}

let isProd = function (req) {
  return req.hasOwnProperty("stageVariables") && req.stageVariables.lambdaAlias && req.stageVariables.lambdaAlias == 'PRD';
}

let isset = function (obj /*, level1, level2, ... levelN*/) {
  var args = Array.prototype.slice.call(arguments, 1);

  for (var i = 0; i < args.length; i++) {
    if (!obj || !obj.hasOwnProperty(args[i])) {
      return false;
    }
    obj = obj[args[i]];
  }
  return true;
}

const AWS = require('aws-sdk');
const {Client} = require('pg');
const md5 = require('md5');

if (getEnvVar('AWS_ACCESS_KEY') && getEnvVar('AWS_SECRET_KEY')) {
  AWS.config.update({
    accessKeyId: getEnvVar('AWS_ACCESS_KEY'),
    secretAccessKey: getEnvVar('AWS_SECRET_KEY'),
    region: getEnvVar('AWS_REGION') || 'us-east-1'
  });
}

const SNS_API_VERSION = getEnvVar('SNS_API_VERSION');
const snsClient = new AWS.SNS({apiVersion: SNS_API_VERSION});

let client = null;
let psqlConnectionString = getEnvVar('PSQL_CONNECTION_STRING');

let dbInit = async function () {
  client = new Client(psqlConnectionString);
  await new Promise((resolve, reject) => {
    client.connect((err) => {
      if (err) {
        console.error('connection error', err.stack)
        return reject(err);
      }

      console.log('connected');
      resolve(true);

    })
  })
}


let sanitizeKey = function(key) {
  return decodeURIComponent(key);
}

exports.handler = async function (request, context, callback) {
  let env = (isProd(request)) ? "PRD" : "DEV";
  let requestResponse = {
    headers: {"Content-Type": "application/json"},
    body: {"success": true},
    statusCode: 200
  };
  let err = null;

  console.log(request);

  try {
    await dbInit();
    if (request.Records) {
      for (let record of request.Records) {

        if (!isset(record, "s3", "object", "key")) {
          continue;
        }

        let recordObject = record.s3.object;
        let sqlInsert = `insert into visitor_fetch_log (num_records, s3key, etag, event_time)`
          + `values (1, '${sanitizeKey(recordObject.key)}', '${recordObject.eTag}', '${record.eventTime}')`;

        let insertP = await client.query(sqlInsert)
          .then(res => {
            console.log(`SUCCESSFUL query: ${sqlInsert}`)
            return res;
          })
          .catch(err => {
            if (err.message && err.message.startsWith("duplicate key")) {
              console.log("DUPLICATE KEY " + sqlInsert);
            } else {
              throw err;
            }
          })
      }
    }


  } catch (e) {
    err = e;
    requestResponse.statusCode = 400;
    requestResponse.body = {"error": e.message};
  }

  if (client) {
    client.end();
  }

  callback(err, requestResponse);

};

let quot = function (v) {

  if (v == null) {
    return `''`;
  }


  return `'${v.toString().replace(new RegExp("'", 'g'), "''")}'`;
}


if (config && config.TEST_REQUEST) {
  let request = config.TEST_REQUEST;

  exports.handler(request, {}, function (err, res) {
    if (err) {
      console.log(err);
    } else {
      console.log(res);
    }
  })
}
