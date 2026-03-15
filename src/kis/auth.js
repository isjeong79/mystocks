const axios    = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('../config');
const KisToken = require('../db/models/KisToken');

let approvalKey = null;
let accessToken = null;

// ── AccessToken: 항상 신규 발급 (KIS는 재발급 시 이전 토큰 즉시 무효화) ──────
async function fetchAccessToken() {
  const now = new Date();

  const res = await axios.post(`${REST_BASE}/oauth2/tokenP`, {
    grant_type: 'client_credentials',
    appkey:     APP_KEY,
    appsecret:  APP_SECRET,
  });

  accessToken = res.data.access_token;
  const expiresIn = res.data.expires_in ?? 86400;
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await KisToken.findOneAndUpdate(
    { appKey: APP_KEY },
    { accessToken, expiresAt },
    { upsert: true, new: true }
  );
  console.log(`[KIS] accessToken 발급 완료 (만료: ${expiresAt.toLocaleString('ko-KR')})`);
}

// ── ApprovalKey: 매 서버 시작마다 재발급 (WebSocket 전용, DB 저장 불필요) ────
async function fetchApprovalKey() {
  const res = await axios.post(`${REST_BASE}/oauth2/Approval`, {
    grant_type: 'client_credentials',
    appkey:     APP_KEY,
    secretkey:  APP_SECRET,
  });
  approvalKey = res.data.approval_key;
}

function getApprovalKey() { return approvalKey; }
function getAccessToken()  { return accessToken; }

module.exports = { fetchApprovalKey, fetchAccessToken, getApprovalKey, getAccessToken };
