const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const APP_KEY    = 'PSZhfi3pK4PCameWNnp002YS3iC0ynNSuiF1';
const APP_SECRET = 'ofumZDvY+H4exA36y6D1d6H0VQgf71KQZ2v3XgMjox93Z2x8mqyBDHC7f4KQAqpfVo9ZT1F23iTM2FAFX3iwmBkTWNGn1T89FJb3aonriOlg7ukuolUDgAfTr8OsEhJic9kMpOCkBpP0tXKddhnPAHHR83ZycM3i0IyRf8ZQPk4fsulrOWo=';
const REST_BASE  = 'https://openapivts.koreainvestment.com:29443';
const KIS_WS_URL = 'ws://ops.koreainvestment.com:31000';
const PORT       = process.env.PORT || 3000;

// 1. 서버 인스턴스를 생성합니다.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('서버가 정상적으로 작동 중입니다.');
});

// 2. app.listen이 아니라 생성한 server.listen을 사용합니다.
server.listen(PORT, () => {
  console.log(`서버가 ${PORT}번 포트에서 실행 중입니다.`);
});

// 만약 WebSocket을 server에 연결하신다면 보통 아래처럼 씁니다.
const wss = new WebSocket.Server({ server });

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

// ── 코스피200 야간선물 앞월물 코드 자동 계산 ─────────────────────────────────
// 형식: 101W + 월코드(A~L) + 연도 끝자리
// 만기: 매월 두번째 목요일. 만기 당일 이후면 다음달 코드 사용
function computeNightFuturesCode() {
  const MONTH_CODES = ['A','B','C','D','E','F','G','H','I','J','K','L'];

  function secondThursday(year, month) { // month: 0-indexed
    let count = 0;
    for (let day = 1; day <= 31; day++) {
      const d = new Date(year, month, day);
      if (d.getMonth() !== month) break;
      if (d.getDay() === 4 && ++count === 2) return d; // 4 = Thursday
    }
    return null;
  }

  const today = new Date();
  let year  = today.getFullYear();
  let month = today.getMonth(); // 0-indexed

  const expiry = secondThursday(year, month);
  if (expiry && today >= expiry) { // 만기 당일 포함 이후 → 다음달
    month++;
    if (month > 11) { month = 0; year++; }
  }

  const code = `101W${MONTH_CODES[month]}${year % 10}`;
  const expiryStr = expiry ? expiry.toLocaleDateString('ko-KR') : '?';
  console.log(`[야간선물 코드] ${code}  (만기일: ${expiryStr}, 오늘: ${today.toLocaleDateString('ko-KR')})`);
  return code;
}

const NIGHT_FUTURES_CODE = computeNightFuturesCode();

// Yahoo Finance 심볼 목록
const YAHOO_SYMBOLS = [
  { symbol: 'CL=F',      type: 'commodity', key: 'WTI',    label: 'WTI 원유' },
  { symbol: 'BZ=F',      type: 'commodity', key: 'BRENT',  label: '브렌트 원유' },
  { symbol: 'USDKRW=X',  type: 'forex',     key: 'USDKRW', label: '원/달러 환율' },
  { symbol: 'QQQ',       type: 'us_etf',    key: 'QQQ',    label: '나스닥100(QQQ)' },
  { symbol: 'SPY',       type: 'us_etf',    key: 'SPY',    label: 'S&P500(SPY)' },
  { symbol: 'DIA',       type: 'us_etf',    key: 'DIA',    label: '다우존스(DIA)' },
];

let approvalKey  = null;
let accessToken  = null;
let kisWs        = null;
let reconnectTimer    = null;
let marketClosedTimer = null;

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

// ── HTTP 서버 ─────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Internal Server Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ── 브라우저용 WebSocket 서버 ──────────────────────────────────────────────────
const clientWss = new WebSocket.Server({ server: httpServer });

clientWss.on('connection', ws => {
  console.log('브라우저 클라이언트 접속');
  ws.send(JSON.stringify({ type: 'init', state }));
  ws.on('close', () => console.log('브라우저 클라이언트 해제'));
  ws.on('error', err => console.error('Client WS error:', err.message));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  console.log('[broadcast]', msg.substring(0, 120));
  clientWss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// ── KIS OAuth ─────────────────────────────────────────────────────────────────
async function getApprovalKey() {
  const res = await axios.post(`${REST_BASE}/oauth2/Approval`, {
    grant_type: 'client_credentials',
    appkey: APP_KEY,
    secretkey: APP_SECRET,
  });
  approvalKey = res.data.approval_key;
  console.log('approval_key 발급 완료');
}

async function getAccessToken() {
  const res = await axios.post(`${REST_BASE}/oauth2/tokenP`, {
    grant_type: 'client_credentials',
    appkey: APP_KEY,
    appsecret: APP_SECRET,
  });
  accessToken = res.data.access_token;
  console.log('access_token 발급 완료');
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── KIS REST: 주식 현재가 초기값 조회 ────────────────────────────────────────
async function fetchKisStockPrices() {
  console.log('[KIS REST] 주식 초기값 조회 시작...');
  for (const stock of STOCKS) {
    try {
      const res = await axios.get(`${REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          appkey: APP_KEY,
          appsecret: APP_SECRET,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
        params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: stock.code },
      });
      console.log(`[KIS REST 주식 원본] ${stock.name}:`, JSON.stringify(res.data?.output).substring(0, 200));
      const out = res.data?.output;
      if (!out) { console.warn(`[KIS REST] ${stock.name} output 없음`); continue; }
      const price      = parseFloat(out.stck_prpr);
      const sign       = out.prdy_vrss_sign;
      const change     = parseFloat(out.prdy_vrss);
      const changeRate = parseFloat(out.prdy_ctrt);
      state.stocks[stock.code] = { ...state.stocks[stock.code], price, sign, change, changeRate };
      broadcast({ type: 'stock', code: stock.code, price, sign, change, changeRate, dir: signToDir(sign) });
    } catch (e) {
      console.error(`[KIS REST] ${stock.name} 조회 실패:`, e.response?.data || e.message);
    }
    await delay(500);
  }
  console.log('[KIS REST] 주식 초기값 조회 완료');
}


// ── Yahoo Finance: 단일 심볼 현재가 조회 ─────────────────────────────────────
async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const res = await axios.get(url, {
    params: { interval: '1m', range: '1d' },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000,
  });
  const meta = res.data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('meta 없음');
  return {
    price:         meta.regularMarketPrice,
    change:        meta.regularMarketChange ?? null,
    changeRate:    meta.regularMarketChangePercent ?? null,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency:      meta.currency,
  };
}

// ── Yahoo Finance: 전체 심볼 갱신 후 broadcast ───────────────────────────────
async function refreshYahoo() {
  for (const item of YAHOO_SYMBOLS) {
    try {
      const data = await fetchYahoo(item.symbol);
      const { price } = data;
      // meta에 change/changeRate 있으면 우선 사용, 없으면 previousClose로 계산
      const change     = data.change     ?? (data.previousClose != null ? parseFloat((price - data.previousClose).toFixed(4)) : null);
      const changeRate = data.changeRate ?? (data.previousClose != null ? parseFloat(((price - data.previousClose) / data.previousClose * 100).toFixed(2)) : null);
      const dir        = change == null ? 'flat' : change > 0 ? 'up' : change < 0 ? 'down' : 'flat';

      console.log(`[Yahoo] ${item.label}(${item.symbol}): ${price}, 전일대비=${change}(${changeRate}%)`);

      if (item.type === 'commodity') {
        state.commodities[item.key] = { price, change, changeRate };
        broadcast({ type: 'commodity', symbol: item.key, price, change, changeRate, dir });
      } else if (item.type === 'forex') {
        state.forex.USDKRW = { rate: price, change, changeRate };
        broadcast({ type: 'forex', currency: 'USDKRW', rate: price, change, changeRate, dir });
      } else if (item.type === 'us_etf') {
        const name = US_ETFS.find(e => e.symbol === item.key)?.name ?? item.key;
        state.usEtfs[item.key] = { name, symbol: item.key, price, change, changeRate };
        broadcast({ type: 'us_etf', symbol: item.key, name, price, change, changeRate, dir });
      }
    } catch (e) {
      console.error(`[Yahoo] ${item.label} 조회 실패:`, e.message);
    }
    await delay(300);
  }
}

// ── Yahoo 30초 폴링 시작 ──────────────────────────────────────────────────────
function startYahooPolling() {
  refreshYahoo(); // 즉시 1회 실행
  setInterval(refreshYahoo, 30_000);
  console.log('[Yahoo] 30초 폴링 시작');
}

// ── esignal.co.kr: 코스피200 야간선물 폴링 ────────────────────────────────────
let nightFuturesPrevClose = null; // 서버 시작시 조회해서 설정

const ESIGNAL_HEADERS = {
  'Referer': 'https://esignal.co.kr/kospi200-futures-night/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// 1️⃣ 주간 종가(전일 종가 기준가)를 Socket.IO 폴링으로 가져오는 함수
async function fetchNightFuturesPrevClose() {
  try {
    console.log(`[esignal 전일종가] Socket.IO 핸드셰이크 시도 중...`);
    
    // 1단계: 서버에 접속해서 새로운 세션 ID(sid) 발급
    const handshakeUrl = 'https://esignal.co.kr/proxy/8888/socket.io/?EIO=3&transport=polling';
    const handshakeRes = await axios.get(handshakeUrl, { headers: ESIGNAL_HEADERS, timeout: 5000, responseType: 'text' });
    
    const sidMatch = handshakeRes.data.match(/"sid":"([^"]+)"/);
    if (!sidMatch || !sidMatch[1]) {
      throw new Error('세션 ID(sid)를 찾을 수 없습니다.');
    }
    const sid = sidMatch[1];

    // 2단계: 발급받은 sid로 실제 데이터 스트림 요청
    const dataUrl = `https://esignal.co.kr/proxy/8888/socket.io/?EIO=3&transport=polling&sid=${sid}`;
    const dataRes = await axios.get(dataUrl, { headers: ESIGNAL_HEADERS, timeout: 5000, responseType: 'text' });
    
    // 3단계: 응답 텍스트에서 'populate' 이벤트 안의 JSON 문자열 추출 및 파싱
    const populateMatch = dataRes.data.match(/42\["populate","(.*?)"\]/);
    if (!populateMatch || !populateMatch[1]) {
      throw new Error('데이터 응답에서 populate 항목을 찾을 수 없습니다.');
    }

    const rawJsonStr = populateMatch[1].replace(/\\"/g, '"');
    const parsedData = JSON.parse(rawJsonStr);

    const dayClosePrice = parseFloat(parsedData.value_day);
    
    if (!isNaN(dayClosePrice) && dayClosePrice > 0) {
      nightFuturesPrevClose = dayClosePrice;
      console.log(`[esignal 전일종가] 🎯 주간종가(value_day) 파싱 완료: ${nightFuturesPrevClose}`);
      return;
    }

  } catch (e) {
    console.error(`[esignal 전일종가] 주간종가 조회 실패:`, e.message);
  }

  console.warn('[esignal 전일종가] 조회 실패. refreshEsignal에서 open 값으로 대체합니다.');
}

/* backup
async function fetchNightFuturesPrevClose() {


  const urls = [
    'https://esignal.co.kr/data/timestamps/kospif_ngt_closing.txt',
    'https://esignal.co.kr/data/cache/kospif_ngt_cache_mtime.txt',
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, { headers: ESIGNAL_HEADERS, timeout: 10000, responseType: 'text' });

      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      console.log(`[esignal 전일종가] URL: ${url}`);
      console.log(`[esignal 전일종가] 응답 전체:`, body);

      // 숫자만 있는 경우 (예: "809.25\n") 파싱 시도
      const num = parseFloat(body.trim());
      if (!isNaN(num) && num > 0) {
        nightFuturesPrevClose = num;
        console.log(`[esignal 전일종가] 파싱 성공: ${num}`);
        return;
      }
      console.warn(`[esignal 전일종가] 숫자 파싱 불가. 다음 URL 시도...`);
    } catch (e) {
      console.error(`[esignal 전일종가] ${url} 조회 실패:`, e.response?.status, e.message);
    }
  }

  console.warn('[esignal 전일종가] 모든 URL 실패. refreshEsignal에서 open 값으로 대체합니다.');

}
*/
// 2️⃣ 실시간 야간선물 차트 데이터를 가져와 클라이언트로 쏴주는 함수
async function refreshEsignal() {
  try {
    const res = await axios.get('https://esignal.co.kr/data/cache/kospif_ngt.js', {
      headers: ESIGNAL_HEADERS,
      timeout: 10000,
    });

    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    let parsed;
    try {
      parsed = typeof res.data === 'object' ? res.data : JSON.parse(raw);
    } catch (_) {
      console.error('[esignal] JSON 파싱 실패. 원본:', raw.substring(0, 200));
      return;
    }
    
    const dataArr = parsed.data;
    if (!Array.isArray(dataArr) || dataArr.length === 0) {
      console.warn('[esignal] data 배열 없음. 원본:', raw.substring(0, 200));
      return;
    }

    // 💡 1. 가장 최신 데이터(맨 마지막 배열 요소)에서 현재가 및 시간 추출
    const latestData = dataArr[dataArr.length - 1];
    const currentTimestamp = latestData[0];
    const price = parseFloat(latestData[1]);

    // 💡 2. 전일종가(주간종가) 세팅: 위 함수에서 구한 값을 최우선으로, 없으면 open 사용
    const prevClose = nightFuturesPrevClose ?? parseFloat(parsed.open); 
    
    // 💡 3. 등락폭, 등락률, 방향 계산
    const change     = parseFloat((price - prevClose).toFixed(2));
    const changeRate = parseFloat(((price - prevClose) / prevClose * 100).toFixed(2));
    const dir        = price > prevClose ? 'up' : price < prevClose ? 'down' : 'flat';

    // (선택) 로그가 너무 길면 콘솔이 지저분해지므로 간결하게 출력
    console.log(`[esignal] 코스피 야간선물: 현재가 ${price} | 기준가 ${prevClose} | 대비 ${change} (${changeRate}%)`);

    // 💡 4. 상태 저장 및 클라이언트로 데이터 브로드캐스트
    state.futures.KOSPI_NIGHT = { price, change, changeRate, timestamp: currentTimestamp };
    
    broadcast({ 
      type: 'futures', 
      symbol: 'KOSPI_NIGHT', 
      name: '코스피 야간선물', 
      price, 
      change, 
      changeRate, 
      dir,
      timestamp: currentTimestamp // 프론트엔드에서 시간 표시용으로 활용 가능!
    });

  } catch (e) {
    console.error('[esignal kospif_ngt.js] 오류:', e.response?.status, e.message);
  }
}

function startEsignalPolling() {
  refreshEsignal(); // 즉시 1회
  setInterval(refreshEsignal, 10_000);
  console.log('[esignal] 10초 폴링 시작');
}

// ── 구독 메시지 생성 ───────────────────────────────────────────────────────────
function subMsg(trId, trKey) {
  return JSON.stringify({
    header: {
      approval_key: approvalKey,
      custtype: 'P',
      tr_type: '1',
      'content-type': 'utf-8',
    },
    body: { input: { tr_id: trId, tr_key: trKey } },
  });
}

function signToDir(sign) {
  if (sign === '1' || sign === '2') return 'up';
  if (sign === '4' || sign === '5') return 'down';
  return 'flat';
}

// ── KIS WebSocket ─────────────────────────────────────────────────────────────
let msgLogCount = 0;

function connectKis() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  msgLogCount = 0;

  console.log(`KIS WebSocket 연결 시도: ${KIS_WS_URL}`);
  kisWs = new WebSocket(KIS_WS_URL, { rejectUnauthorized: false });

  kisWs.on('open', () => {
    console.log('KIS WebSocket 연결됨 — 구독 전송');

    // 국내주식 + 환율 + 야간선물 구독 (원자재는 Yahoo로 대체)
    STOCKS.forEach(s => kisWs.send(subMsg('H0STCNT0', s.code)));
    kisWs.send(subMsg('H0FOREXS', 'FX@USD'));
    kisWs.send(subMsg('H0NOCNT0', NIGHT_FUTURES_CODE));

    if (marketClosedTimer) clearTimeout(marketClosedTimer);
    marketClosedTimer = setTimeout(() => {
      console.log('[타임아웃] 30초간 주식 시세 없음 → 장 마감 안내');
      broadcast({ type: 'market_closed', message: '현재 장이 닫혀있어 실시간 데이터가 없습니다.' });
    }, 30_000);
  });

  kisWs.on('message', raw => {
    const text = raw.toString();

    if (msgLogCount < 10) {
      console.log(`[KIS 원문 #${msgLogCount + 1}] ${text.substring(0, 200)}`);
      msgLogCount++;
    }

    if (text.startsWith('{')) {
      try {
        const json = JSON.parse(text);
        const trId = json?.header?.tr_id;
        const msg  = json?.body?.msg1 || '';
        if (trId) console.log(`[KIS JSON] tr_id=${trId} msg=${msg}`);
        if (trId === 'PINGPONG') kisWs.send(text);
      } catch (_) {}
      return;
    }

    const parts = text.split('|');
    if (parts.length < 4) return;

    const [, trId, , dataStr] = parts;
    const f = dataStr.split('^');

    console.log(`[KIS 파싱] tr_id=${trId} fields[0..5]=${f.slice(0, 6).join(',')}`);

    if (marketClosedTimer) { clearTimeout(marketClosedTimer); marketClosedTimer = null; }

    switch (trId) {
      case 'H0STCNT0': {
        const code       = f[0];
        const price      = parseFloat(f[2]);
        const sign       = f[3];
        const change     = parseFloat(f[4]);
        const changeRate = parseFloat(f[5]);
        if (!state.stocks[code]) break;
        state.stocks[code] = { ...state.stocks[code], price, sign, change, changeRate };
        broadcast({ type: 'stock', code, price, sign, change, changeRate, dir: signToDir(sign) });
        break;
      }

      case 'H0FOREXS':
      case 'H0FOREXS0': {
        // 0:통화코드 1:시간 2:현재환율
        const rate = parseFloat(f[2]);
        state.forex.USDKRW = { ...state.forex.USDKRW, rate };
        broadcast({ type: 'forex', currency: 'USDKRW', rate, dir: 'flat' });
        break;
      }

      case 'H0NOCNT0': {
        const price      = parseFloat(f[2]);
        const sign       = f[3];
        const change     = parseFloat(f[4]);
        const changeRate = parseFloat(f[5]);
        console.log(`[H0NOCNT0 파싱] 코드=${f[0]} 시간=${f[1]} 현재가=${price} 부호=${sign} 전일대비=${change} 등락률=${changeRate}% 전체필드수=${f.length}`);
        state.futures.KOSPI_NIGHT = { price, change, changeRate };
        broadcast({ type: 'futures', name: '코스피 야간선물', price, change, changeRate, dir: signToDir(sign) });
        break;
      }

      default:
        console.log(`[KIS] 알 수 없는 tr_id: ${trId}`);
        break;
    }
  });

  kisWs.on('close', (code, reason) => {
    if (marketClosedTimer) { clearTimeout(marketClosedTimer); marketClosedTimer = null; }
    console.log(`KIS WebSocket 종료 (${code}): ${reason}`);
    scheduleReconnect();
  });

  kisWs.on('error', err => {
    console.error('KIS WebSocket 오류:', err.message);
  });
}

function scheduleReconnect() {
  console.log('5초 후 재연결 시도...');
  reconnectTimer = setTimeout(async () => {
    try {
      await getApprovalKey();
      connectKis();
    } catch (err) {
      console.error('재연결 실패:', err.message);
      scheduleReconnect();
    }
  }, 5000);
}

// ── 시작 ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, async () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
  try {
    await Promise.all([getApprovalKey(), getAccessToken()]);
    await fetchKisStockPrices();          // KIS REST: 주식 초기값
    await fetchNightFuturesPrevClose();   // esignal: 야간선물 전일종가 조회
    startYahooPolling();                  // Yahoo: 환율/원자재 (30초 폴링)
    startEsignalPolling();                // esignal: 코스피200 야간선물 (10초 폴링)
    connectKis();                  // KIS WebSocket: 주식 + 야간선물 실시간
  } catch (err) {
    console.error('초기화 실패:', err.message);
    scheduleReconnect();
  }
});
