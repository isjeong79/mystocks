const axios = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('../config');

let approvalKey = null;
let accessToken = null;

async function fetchApprovalKey() {
  const res = await axios.post(`${REST_BASE}/oauth2/Approval`, {
    grant_type: 'client_credentials',
    appkey:     APP_KEY,
    secretkey:  APP_SECRET,
  });
  approvalKey = res.data.approval_key;
}

async function fetchAccessToken() {
  const res = await axios.post(`${REST_BASE}/oauth2/tokenP`, {
    grant_type: 'client_credentials',
    appkey:     APP_KEY,
    appsecret:  APP_SECRET,
  });
  accessToken = res.data.access_token;
}

function getApprovalKey() { return approvalKey; }
function getAccessToken()  { return accessToken; }

module.exports = { fetchApprovalKey, fetchAccessToken, getApprovalKey, getAccessToken };
