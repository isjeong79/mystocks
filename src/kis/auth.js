const axios    = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('../config');
const KisToken = require('../db/models/KisToken');

let approvalKey = null;
let accessToken = null;

// ── AccessToken: DB 캐시 검증 후 유효하면 재사용, force=true면 무조건 재발급 ──
async function fetchAccessToken(force = false) {
  const now    = new Date();
  const buffer = 5 * 60 * 1000; // 만료 5분 전부터 갱신

  if (!force) {
    const cached = await KisToken.findOne({ appKey: APP_KEY }).lean();
    if (cached && cached.expiresAt.getTime() - buffer > now.getTime()) {
      accessToken = cached.accessToken;
      const remaining = Math.round((cached.expiresAt.getTime() - now.getTime()) / 60000);
      console.log(`[KIS] accessToken DB 캐시 사용 (잔여 ${remaining}분)`);
      return;
    }
  }

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
    { upsert: true, returnDocument: 'after' }
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
