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

let sanitize = function (message) {
  try {
    message = JSON.parse(message)
  } catch (e) {

  }

  let originationNumber = message.originationNumber;
  let text = message.messageBody;
  if (text) {
    text = text.trim();
  }

  if (!(originationNumber && text)) {
    throw new Error("Missing params");
  }

  let sanitizedMessage = {
    originationNumber: originationNumber,
    text: text
  }

  return sanitizedMessage;
}

let validateUser = async function (sanitizedMessage) {
  let {originationNumber, text} = sanitizedMessage;

  let sql = "select p.id as patient_id, p.phone, p.status as patient_status, v.id as visit_id, v.visited_on, v.status as visit_status, v.hash as visit_hash, p.sample_id\n" +
    "from patient p \n" +
    "join visit v on p.id=v.patient_id \n" +
    "where p.status in ('SENT', 'SEEN') \n" +
    "and v.status = 'PROCESSED' \n" +
    `and p.phone ='${originationNumber}'`

  let res = await client.query(sql);
  if (res.rows.length == 0) {
    throw new Error(`User ${originationNumber} has no active visits`);
  }

  return res.rows[0];
}


let parseReview = async function (sanitizedMessage, user, hash, hashUrl) {
  let {originationNumber, text} = sanitizedMessage;

  let messageBack = "Sorry, what was that?";
  console.log(text);

  let rating = parseInt(text);
  if (isNaN(rating)) {
    console.log("The response is not numeric")
    return null;
  }

  if (rating != text) {
    console.log("The response could not get interpreted");
    return null;
  }

  if (rating > 5 || rating < 1) {
    console.log("The rating is not valid");
    return null;
  }

  let link = `${getEnvVar('WEB_URL')}/#/${hashUrl}`

  switch (rating) {
    case 1:
    case 2:
    case 3:
      messageBack = `We are sorry to hear that. You could call us or follow this link to tell us how to improve our service ${link}`
      break;
    case 4:
    case 5:
      messageBack = `Thank you! Please review on Google for extra discounts by following the link ${link}`;
      break;
  }

  let sqlInsert = `insert into review (patient_id, visit_id, rating, hash)`
    + `values (${user.patient_id}, ${user.visit_id}, ${rating}, ${quot(hash)})`;

  let sqlUpdate = `update review set rating=${rating}, hash=${quot(hash)} `
    + `where patient_id=${user.patient_id} and visit_id=${user.visit_id}`

  let sqlUpdatePatientStatus = `update patient set status = 'RATED' where id=${user.patient_id}`;
  let sqlUpdateVisitStatus = `update visit set status = 'RATED' where id=${user.visit_id}`;

  let insertP = client.query(sqlInsert)
    .then(res => {
      console.log("her");
    })
    .catch(err => {
      if (err.message && err.message.startsWith("duplicate key")) {
        return client.query(sqlUpdate);
      } else {
        throw err;
      }
    })

  let promises = [insertP, client.query(sqlUpdatePatientStatus), client.query(sqlUpdateVisitStatus)]

  await Promise.all(promises);

  return messageBack;
}

let sendResponse = async function(message, phone) {
  let params = {
    Message: message,
    PhoneNumber: phone,
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': {
        DataType: 'String',
        StringValue: 'Transactional'
      }
    }
  };

  // send
  let publishTextPromise = snsClient.publish(params).promise();

  let data = await publishTextPromise;
  console.log("MessageID is " + data.MessageId);
}

exports.handler = async function (request, context, callback) {
  let env = (isProd(request)) ? "PRD" : "DEV";
  let requestResponse = {
    headers: {"Content-Type": "application/json"},
    body: {"hash": ""},
    statusCode: 200
  };
  let err = null;

  console.log(request);

  try {
    await dbInit();
    if (request.Records) {
      for (let record of request.Records) {
        let message = record.Sns.Message;
        console.log(message);
        try {
          let sanitizedMessage = sanitize(message);
          let user = await validateUser(sanitizedMessage);
          // let hash = makeHash(6);
          let hash = user.visit_hash;
          let hashUrl = generateHashUrl(user, hash);
          let responseMessage = await parseReview(sanitizedMessage, user, hash, hashUrl);

          if (user.sample_id == 1) {
            await sendResponse(responseMessage, user.phone);
          }
          requestResponse.body.hash = hashUrl;
        } catch (e) {
          console.error(e.message);
          throw e;
        }
      }
    }

  } catch (e) {
    err = e;
    requestResponse.statusCode = 400;
    requestResponse.body = {"error" : e.message};
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

function makeHash(length) {
  var result           = '';
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

function generateHashUrl(user, hash) {
  let str = `${user.patient_id},${user.phone}`
  let mdhash = md5(str).toLowerCase();
  let fullHash = `${mdhash},${hash}`;
  let buff = new Buffer(fullHash);
  let base64data = buff.toString('base64');
  return base64data;
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
