const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── 설정 및 상수 ──────────────────────────────────────────────────────────────
const APP_KEY    = 'PSZhfi3pK4PCameWNnp002YS3iC0ynNSuiF1';
const APP_SECRET = 'ofumZDvY+H4exA36y6D1d6H0VQgf71KQZ2v3XgMjox93Z2x8mqyBDHC7f4KQAqpfVo9ZT1F23iTM2FAFX3iwmBkTWNGn1T89FJb3aonriOlg7ukuolUDgAfTr8OsEhJic9kMpOCkBpP0tXKddhnPAHHR83ZycM3i0IyRf8ZQPk4fsulrOWo=';
const REST_BASE  = 'https://openapivts.koreainvestment.com:29443';
const KIS_WS_URL = 'ws://ops.koreainvestment.com:31000';
const PORT       = process.env.PORT || 3000;

const STOCKS = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '005380', name: '현대차' },
];

const US_ETFS = [
  { symbol: 'QQQ', name: '나스닥100(QQQ)' },
  { symbol: 'SPY', name: 'S&P500(SPY)' },
  { symbol: 'DIA', name: '다우존스(DIA)' },
];

// Yahoo Finance 심볼 목록
const YAHOO_SYMBOLS = [
  { symbol: 'CL=F',      type: 'commodity', key: 'WTI',    label: 'WTI 원유' },
  { symbol: 'BZ=F',      type: 'commodity', key: 'BRENT',  label: '브렌트 원유' },
  { symbol: 'USDKRW=X',  type: 'forex',     key: 'USDKRW', label: '원/달러 환율' },
  { symbol: 'QQQ',       type: 'us_etf',    key: 'QQQ',    label: '나스닥100(QQQ)' },
  { symbol: 'SPY',       type: 'us_etf',    key: 'SPY',    label: 'S&P500(SPY)' },
  { symbol: 'DIA',       type: 'us_etf',    key: 'DIA',    label: '다우존스(DIA)' },
];

// ── 전역 상태 ─────────────────────────────────────────────────────────────────
let approvalKey  = null;
let accessToken  = null;
let kisWs        = null;
let reconnectTimer    = null;
let marketClosedTimer = null;
let nightFuturesPrevClose = null; 

const state = {
  stocks: {},
  usEtfs: {},
  forex: { USDKRW: { rate: null, change: null, changeRate: null } },
  commodities: {
    WTI:   { price: null, change: null, changeRate: null },
    BRENT: { price: null, change: null, changeRate: null },
  },
  futures: { KOSPI_NIGHT: { price: null, change: null, changeRate: null } },
};

STOCKS.forEach(s => {
  state.stocks[s.code] = { name: s.name, code: s.code, price: null, change: null, changeRate: null, sign: '3' };
});
US_ETFS.forEach(e => {
  state.usEtfs[e.symbol] = { name: e.name, symbol: e.symbol, price: null, change: null, changeRate: null };
});

// ── HTTP 서버 (하나의 인스턴스로 통합) ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Internal Server Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('서버가 정상 작동 중입니다.');
  }
});

// ── 브라우저용 WebSocket 서버 (HTTP 서버 공유) ──────────────────────────────────
const clientWss = new WebSocket.Server({ server });

clientWss.on('connection', ws => {
  console.log('브라우저 클라이언트 접속');
  ws.send(JSON.stringify({ type: 'init', state }));
  ws.on('close', () => console.log('브라우저 클라이언트 해제'));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clientWss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// ── 유틸리티 함수 ─────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

function signToDir(sign) {
  if (sign === '1' || sign === '2') return 'up';
  if (sign === '4' || sign === '5') return 'down';
  return 'flat';
}

function computeNightFuturesCode() {
  const MONTH_CODES = ['A','B','C','D','E','F','G','H','I','J','K','L'];
  function secondThursday(year, month) {
    let count = 0;
    for (let day = 1; day <= 31; day++) {
      const d = new Date(year, month, day);
      if (d.getMonth() !== month) break;
      if (d.getDay() === 4 && ++count === 2) return d;
    }
    return null;
  }
  const today = new Date();
  let year  = today.getFullYear();
  let month = today.getMonth();
  const expiry = secondThursday(year, month);
  if (expiry && today >= expiry) {
    month++; if (month > 11) { month = 0; year++; }
  }
  return `101W${MONTH_CODES[month]}${year % 10}`;
}
const NIGHT_FUTURES_CODE = computeNightFuturesCode();

// ── 데이터 연동 로직 (KIS, Yahoo, Esignal) ────────────────────────────────────

// 1. KIS 인증
async function getApprovalKey() {
  const res = await axios.post(`${REST_BASE}/oauth2/Approval`, {
    grant_type: 'client_credentials', appkey: APP_KEY, secretkey: APP_SECRET,
  });
  approvalKey = res.data.approval_key;
}

async function getAccessToken() {
  const res = await axios.post(`${REST_BASE}/oauth2/tokenP`, {
    grant_type: 'client_credentials', appkey: APP_KEY, appsecret: APP_SECRET,
  });
  accessToken = res.data.access_token;
}

// 2. KIS 주식 초기값
async function fetchKisStockPrices() {
  for (const stock of STOCKS) {
    try {
      const res = await axios.get(`${REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`, {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, appkey: APP_KEY, appsecret: APP_SECRET, tr_id: 'FHKST01010100', custtype: 'P' },
        params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: stock.code },
      });
      const out = res.data?.output;
      if (out) {
        const price = parseFloat(out.stck_prpr);
        const sign = out.prdy_vrss_sign;
        state.stocks[stock.code] = { ...state.stocks[stock.code], price, sign, change: parseFloat(out.prdy_vrss), changeRate: parseFloat(out.prdy_ctrt) };
        broadcast({ type: 'stock', code: stock.code, price, sign, change: parseFloat(out.prdy_vrss), changeRate: parseFloat(out.prdy_ctrt), dir: signToDir(sign) });
      }
    } catch (e) { console.error(`[KIS REST] ${stock.name} 실패:`, e.message); }
    await delay(500);
  }
}

// 3. 야간선물 주간종가(809.25) 조회
async function fetchNightFuturesPrevClose() {
  try {
    const headers = { 'Referer': 'https://esignal.co.kr/kospi200-futures-night/', 'User-Agent': 'Mozilla/5.0' };
    const hRes = await axios.get('https://esignal.co.kr/proxy/8888/socket.io/?EIO=3&transport=polling', { headers });
    const sid = hRes.data.match(/"sid":"([^"]+)"/)?.[1];
    if (sid) {
      const dRes = await axios.get(`https://esignal.co.kr/proxy/8888/socket.io/?EIO=3&transport=polling&sid=${sid}`, { headers });
      const popMatch = dRes.data.match(/42\["populate","(.*?)"\]/);
      if (popMatch) {
        const parsed = JSON.parse(popMatch[1].replace(/\\"/g, '"'));
        nightFuturesPrevClose = parseFloat(parsed.value_day);
        console.log(`[esignal] 🎯 주간종가 파싱 완료: ${nightFuturesPrevClose}`);
      }
    }
  } catch (e) { console.error(`[esignal] 전일종가 실패:`, e.message); }
}

// 4. 야간선물 실시간 폴링
async function refreshEsignal() {
  try {
    const res = await axios.get('https://esignal.co.kr/data/cache/kospif_ngt.js', { headers: { 'Referer': 'https://esignal.co.kr/', 'User-Agent': 'Mozilla/5.0' } });
    const dataArr = res.data.data;
    if (dataArr && dataArr.length > 0) {
      const price = parseFloat(dataArr[dataArr.length - 1][1]);
      const prevClose = nightFuturesPrevClose ?? parseFloat(res.data.open);
      const change = parseFloat((price - prevClose).toFixed(2));
      const changeRate = parseFloat(((price - prevClose) / prevClose * 100).toFixed(2));
      state.futures.KOSPI_NIGHT = { price, change, changeRate };
      broadcast({ type: 'futures', symbol: 'KOSPI_NIGHT', name: '코스피 야간선물', price, change, changeRate, dir: price > prevClose ? 'up' : 'down' });
    }
  } catch (e) { console.error('[esignal] 폴링 오류'); }
}

// 5. Yahoo Finance (환율/원자재)
async function refreshYahoo() {
  for (const item of YAHOO_SYMBOLS) {
    try {
      const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}`, { params: { interval: '1m', range: '1d' }, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const meta = res.data?.chart?.result?.[0]?.meta;
      if (meta) {
        const price = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose || meta.previousClose;
        const change = parseFloat((price - prev).toFixed(4));
        const changeRate = parseFloat(((price - prev) / prev * 100).toFixed(2));
        if (item.type === 'commodity') state.commodities[item.key] = { price, change, changeRate };
        else if (item.type === 'forex') state.forex.USDKRW = { rate: price, change, changeRate };
        broadcast({ type: item.type, symbol: item.key, currency: 'USDKRW', price, rate: price, change, changeRate, dir: change > 0 ? 'up' : 'down' });
      }
    } catch (e) { console.error(`[Yahoo] ${item.label} 실패`); }
    await delay(300);
  }
}

// ── KIS WebSocket 실시간 ──────────────────────────────────────────────────────
function connectKis() {
  kisWs = new WebSocket(KIS_WS_URL);
  kisWs.on('open', () => {
    const sub = (id, key) => JSON.stringify({ header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' }, body: { input: { tr_id: id, tr_key: key } } });
    STOCKS.forEach(s => kisWs.send(sub('H0STCNT0', s.code)));
    kisWs.send(sub('H0FOREXS', 'FX@USD'));
    kisWs.send(sub('H0NOCNT0', NIGHT_FUTURES_CODE));
  });
  kisWs.on('message', data => {
    const text = data.toString();
    if (text.startsWith('{')) return;
    const parts = text.split('|');
    if (parts.length < 4) return;
    const trId = parts[1];
    const f = parts[3].split('^');
    if (trId === 'H0STCNT0') {
      const code = f[0];
      state.stocks[code] = { ...state.stocks[code], price: parseFloat(f[2]), sign: f[3], change: parseFloat(f[4]), changeRate: parseFloat(f[5]) };
      broadcast({ type: 'stock', code, price: parseFloat(f[2]), sign: f[3], change: parseFloat(f[4]), changeRate: parseFloat(f[5]), dir: signToDir(f[3]) });
    }
  });
  kisWs.on('close', () => setTimeout(connectKis, 5000));
}

// ── 시작 ──────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`서버 오픈: 포트 ${PORT}`);
  try {
    await Promise.all([getApprovalKey(), getAccessToken()]);
    await fetchKisStockPrices();
    await fetchNightFuturesPrevClose();
    setInterval(refreshYahoo, 30000); refreshYahoo();
    setInterval(refreshEsignal, 10000); refreshEsignal();
    connectKis();
  } catch (err) { console.error('초기화 실패:', err.message); }
});