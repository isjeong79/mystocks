require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── 설정 및 상수 ──────────────────────────────────────────────────────────────
const APP_KEY    = process.env.KIS_APP_KEY;
const APP_SECRET = process.env.KIS_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
  console.error('환경변수 KIS_APP_KEY, KIS_APP_SECRET 필요');
  process.exit(1);
}

const REST_BASE  = 'https://openapi.koreainvestment.com:9443';
const KIS_WS_URL = 'ws://ops.koreainvestment.com:21000';
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

// Yahoo Finance: 미국 ETF만 (원자재는 investing.com으로 분리)
const YAHOO_SYMBOLS = [
  { symbol: 'QQQ', key: 'QQQ', label: '나스닥100(QQQ)' },
  { symbol: 'SPY', key: 'SPY', label: 'S&P500(SPY)' },
  { symbol: 'DIA', key: 'DIA', label: '다우존스(DIA)' },
];

// investing.com 원자재 ID
const INVESTING_COMMODITIES = [
  { id: 8833, key: 'WTI',   name: 'WTI 원유' },
  { id: 8862, key: 'BRENT', name: '브렌트 원유' },
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

// 5. 원자재 (WTI, 브렌트) - Yahoo Finance v7 quote + stooq fallback
const COMMODITY_YAHOO = { 'CL=F': 'WTI', 'BZ=F': 'BRENT' };
const COMMODITY_STOOQ = [
  { s: 'cl.f', key: 'WTI',   name: 'WTI 원유' },
  { s: 'cb.f', key: 'BRENT', name: '브렌트 원유' },
];

async function refreshCommodityStooq() {
  for (const item of COMMODITY_STOOQ) {
    try {
      // stooq 일별 데이터 2행: 전일 + 오늘
      const res = await axios.get(`https://stooq.com/q/d/l/?s=${item.s}&i=d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000,
      });
      const lines = res.data.trim().split('\n').filter(l => l && !l.startsWith('Date'));
      if (lines.length < 2) { console.warn(`[Stooq] ${item.name} 데이터 부족`); continue; }
      // Date,Open,High,Low,Close,Volume
      const prev  = parseFloat(lines[lines.length - 2].split(',')[4]); // 전일 Close
      const price = parseFloat(lines[lines.length - 1].split(',')[4]); // 오늘 Close
      const change     = parseFloat((price - prev).toFixed(2));
      const changeRate = parseFloat(((price - prev) / prev * 100).toFixed(2));
      state.commodities[item.key] = { price, change, changeRate };
      broadcast({ type: 'commodity', symbol: item.key, name: item.name, price, change, changeRate, dir: change > 0 ? 'up' : 'down' });
      console.log(`[Stooq] ${item.name}: ${price} (${change > 0 ? '+' : ''}${change})`);
    } catch (e) { console.error(`[Stooq] ${item.name} 실패:`, e.message); }
    await delay(300);
  }
}

async function refreshInvesting() {
  try {
    // Yahoo Finance v7 quote: regularMarketPrice + regularMarketPreviousClose 한 번에
    const res = await axios.get('https://query1.finance.yahoo.com/v7/finance/quote', {
      params: { symbols: 'CL=F,BZ=F', fields: 'regularMarketPrice,regularMarketPreviousClose,regularMarketChange,regularMarketChangePercent' },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
      timeout: 10000,
    });
    const quotes = res.data?.quoteResponse?.result;
    if (!quotes || quotes.length === 0) throw new Error('결과 없음');

    for (const q of quotes) {
      const key  = COMMODITY_YAHOO[q.symbol];
      if (!key) continue;
      const item = INVESTING_COMMODITIES.find(c => c.key === key);
      const price      = q.regularMarketPrice;
      const prev       = q.regularMarketPreviousClose;
      const change     = parseFloat((price - prev).toFixed(2));
      const changeRate = parseFloat(((price - prev) / prev * 100).toFixed(2));
      state.commodities[key] = { price, change, changeRate };
      broadcast({ type: 'commodity', symbol: key, name: item?.name ?? key, price, change, changeRate, dir: change > 0 ? 'up' : 'down' });
    }
  } catch (e) {
    console.error('[Yahoo Commodity] 실패:', e.message, '→ stooq fallback');
    await refreshCommodityStooq();
  }
}

// 6. Yahoo Finance 미국 ETF (QQQ, SPY, DIA) - v7 quote API
async function refreshYahoo() {
  try {
    const symbols = YAHOO_SYMBOLS.map(y => y.symbol).join(',');
    const res = await axios.get('https://query1.finance.yahoo.com/v7/finance/quote', {
      params: { symbols, fields: 'regularMarketPrice,regularMarketPreviousClose,regularMarketChange,regularMarketChangePercent' },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
      timeout: 10000,
    });
    const quotes = res.data?.quoteResponse?.result;
    if (!quotes || quotes.length === 0) throw new Error('결과 없음');

    for (const q of quotes) {
      const item = YAHOO_SYMBOLS.find(y => y.symbol === q.symbol);
      if (!item) continue;
      const price      = q.regularMarketPrice;
      const prev       = q.regularMarketPreviousClose;
      const change     = parseFloat((price - prev).toFixed(2));
      const changeRate = parseFloat(((price - prev) / prev * 100).toFixed(2));
      state.usEtfs[item.key] = { ...state.usEtfs[item.key], price, change, changeRate };
      broadcast({ type: 'us_etf', symbol: item.key, name: item.label, price, change, changeRate, dir: change > 0 ? 'up' : 'down' });
    }
  } catch (e) {
    console.error('[Yahoo ETF] 실패:', e.message);
    // fallback: stooq
    await refreshEtfStooq();
  }
}

async function refreshEtfStooq() {
  const stooqEtfs = [
    { s: 'qqq.us', key: 'QQQ', label: '나스닥100(QQQ)' },
    { s: 'spy.us', key: 'SPY', label: 'S&P500(SPY)' },
    { s: 'dia.us', key: 'DIA', label: '다우존스(DIA)' },
  ];
  for (const item of stooqEtfs) {
    try {
      const res = await axios.get(`https://stooq.com/q/d/l/?s=${item.s}&i=d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000,
      });
      const lines = res.data.trim().split('\n').filter(l => l && !l.startsWith('Date'));
      if (lines.length < 2) continue;
      const prev  = parseFloat(lines[lines.length - 2].split(',')[4]);
      const price = parseFloat(lines[lines.length - 1].split(',')[4]);
      const change     = parseFloat((price - prev).toFixed(2));
      const changeRate = parseFloat(((price - prev) / prev * 100).toFixed(2));
      state.usEtfs[item.key] = { ...state.usEtfs[item.key], price, change, changeRate };
      broadcast({ type: 'us_etf', symbol: item.key, name: item.label, price, change, changeRate, dir: change > 0 ? 'up' : 'down' });
      console.log(`[Stooq ETF] ${item.label}: ${price}`);
    } catch (e) { console.error(`[Stooq ETF] ${item.label} 실패:`, e.message); }
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

    // ── JSON 메시지 (구독응답, 오류, PINGPONG) ──────────────────────────────
    if (text.startsWith('{')) {
      try {
        const json = JSON.parse(text);
        const trId = json.header?.tr_id;
        if (trId === 'PINGPONG') {
          kisWs.send(text);
        } else {
          // 구독 성공/실패 응답 확인
          console.log(`[KIS WS JSON] tr_id=${trId} body:`, JSON.stringify(json.body ?? json).substring(0, 300));
        }
      } catch (_) {}
      return;
    }

    // ── 파이프 구분 실시간 데이터 ───────────────────────────────────────────
    const parts = text.split('|');
    if (parts.length < 4) return;
    const trId = parts[1];
    const f    = parts[3].split('^');

    if (trId === 'H0STCNT0') {
      const code = f[0];
      state.stocks[code] = { ...state.stocks[code], price: parseFloat(f[2]), sign: f[3], change: parseFloat(f[4]), changeRate: parseFloat(f[5]) };
      broadcast({ type: 'stock', code, price: parseFloat(f[2]), sign: f[3], change: parseFloat(f[4]), changeRate: parseFloat(f[5]), dir: signToDir(f[3]) });

    } else if (trId === 'H0FOREXS' || trId === 'H0FOREXS0') {
      // 수신된 전체 필드 로그 (필드 인덱스 확인용)
      console.log(`[KIS WS] ${trId} 전체필드(${f.length}개):`, f.slice(0, 15));
      // f[0]: 통화코드, f[1]: 시간, f[2]: 현재환율
      const rate = parseFloat(f[2]);
      if (!rate) { console.warn(`[KIS WS] ${trId} rate 파싱 실패, f[2]="${f[2]}"`); return; }
      const prev       = state.forex.USDKRW.rate || rate;
      const change     = parseFloat((rate - prev).toFixed(2));
      const changeRate = parseFloat(((rate - prev) / prev * 100).toFixed(2));
      state.forex.USDKRW = { rate, change, changeRate };
      broadcast({ type: 'forex', symbol: 'USDKRW', name: '원/달러 환율', rate, change, changeRate, dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' });

    } else {
      // 알 수 없는 TR_ID 로그 (H0NOCNT0 등 확인용)
      console.log(`[KIS WS] 미처리 trId=${trId} fields[0-4]:`, f.slice(0, 5));
    }
  });
  kisWs.on('close', () => setTimeout(connectKis, 5000));
}

// ── 시작 ──────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`서버 오픈: 포트 ${PORT}`);

  // KIS 인증 (실패해도 폴링 소스는 계속 시작)
  try {
    await Promise.all([getApprovalKey(), getAccessToken()]);
    console.log('[KIS] 인증 성공');
    await fetchKisStockPrices();
  } catch (err) {
    console.error('[KIS] 인증/주식 초기화 실패:', err.message, '(상태코드:', err.response?.status ?? '-', ')');
    console.warn('[KIS] KIS 없이 폴링 소스만 사용합니다.');
  }

  // esignal 전일종가 (실패해도 무시)
  try { await fetchNightFuturesPrevClose(); } catch (_) {}

  // 폴링 소스 — KIS 실패와 무관하게 항상 시작
  setInterval(refreshInvesting, 30000); refreshInvesting();
  setInterval(refreshYahoo, 30000); refreshYahoo();
  setInterval(refreshEsignal, 10000); refreshEsignal();

  // KIS WebSocket — approvalKey 있을 때만 연결
  if (approvalKey) {
    connectKis();
  } else {
    console.warn('[KIS] approvalKey 없음 → WebSocket 연결 건너뜀');
  }
});