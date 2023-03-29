require('dotenv').config()
let config = {}

try {
  config = require("./config.json");
} catch (e) {
  // ok
}

function getEnvVar(name) {
  return process.env[name] || config[name];
}

var AWS = require('aws-sdk');
if (getEnvVar('AWS_ACCESS_KEY') && getEnvVar('AWS_SECRET_KEY')) {
  AWS.config.update({
    accessKeyId: getEnvVar('AWS_ACCESS_KEY'),
    secretAccessKey: getEnvVar('AWS_SECRET_KEY'),
    region: getEnvVar('AWS_REGION') || 'us-east-1'
  });
}

const SNS_API_VERSION = getEnvVar('SNS_API_VERSION');
const snsClient = new AWS.SNS({apiVersion: SNS_API_VERSION});

exports.handler = async (event) => {
  let response = {
    statusCode: 200,
    body: JSON.stringify('Sent'),
  };

  if (!(event.pn && event.msg)) {
    response.statusCode = 400;
    response.body = "Missing params.";
    return response;
  }


  var params = {
    Message: event.msg,
    PhoneNumber: event.pn,
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': {
        DataType: 'String',
        StringValue: 'Transactional'
      }
    }
  };

  console.log(`${event.msg}`)

// Create promise and SNS service object
  let publishTextPromise = snsClient.publish(params).promise();

// Handle promise's fulfilled/rejected states

  await publishTextPromise.then(
    function(data) {
      console.log("MessageID is " + data.MessageId);
    }).catch(
    function(err) {
      console.error(err, err.stack);
    });

  return response;
};

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
