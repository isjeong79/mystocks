require('dotenv').config();

const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

const { APP_KEY, APP_SECRET } = require('./src/config');
if (!APP_KEY || !APP_SECRET) { console.error('환경변수 KIS_APP_KEY, KIS_APP_SECRET 필요'); process.exit(1); }

const { PORT } = require('./src/config');
const state    = require('./src/state');
const broadcast = require('./src/broadcast');
const { loadWatchlist, initStateFromWatchlist, getWatchlistItems, getWatchlistWithPrices } = require('./src/watchlist');
const { handleAddStock, handleRemoveStock } = require('./src/handlers');
const { searchDomesticStocks, searchForeignStocks } = require('./src/search');
const { fetchApprovalKey, fetchAccessToken, getApprovalKey } = require('./src/kis/auth');
const { fetchKisStockPrices, fetchInitialForeignPrices } = require('./src/kis/prices');
const { connectKis, startSessionMonitor } = require('./src/kis/websocket');
const { refreshCommodities } = require('./src/market/commodities');
const { refreshForex }       = require('./src/market/forex');
const { connectEsignalNightFutures } = require('./src/futures/esignal');
const { refreshHolidays }    = require('./src/holidays');

// ── HTTP 서버 ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const q    = url.searchParams.get('q') ?? '';
    const type = url.searchParams.get('type') ?? 'domestic';
    if (!q.trim()) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
    try {
      const results = type === 'domestic' ? await searchDomesticStocks(q) : await searchForeignStocks(q);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(results));
    } catch (e) {
      console.error('[Search] 실패:', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK');
});

// ── 브라우저 WebSocket ────────────────────────────────────────────────────────
const clientWss = new WebSocket.Server({ server });
broadcast.init(clientWss);

clientWss.on('connection', ws => {
  console.log('브라우저 접속');
  ws.send(JSON.stringify({ type: 'init', state, watchlist: getWatchlistWithPrices() }));
  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());
      if      (msg.type === 'add_stock')    await handleAddStock(msg);
      else if (msg.type === 'remove_stock')       handleRemoveStock(msg);
    } catch (e) { console.error('[WS] 메시지 처리 오류:', e.message); }
  });
  ws.on('close', () => console.log('브라우저 해제'));
});

// ── 시작 ──────────────────────────────────────────────────────────────────────
loadWatchlist();
initStateFromWatchlist();

server.listen(PORT, async () => {
  console.log(`서버 오픈: 포트 ${PORT}`);

  await Promise.allSettled([
    fetchApprovalKey()
      .then(() => console.log('[KIS] approvalKey 발급 완료'))
      .catch(e => {
        console.error('[KIS] approvalKey 실패:', e.message, e.response?.data ? JSON.stringify(e.response.data) : '');
      }),
    fetchAccessToken()
      .then(() => console.log('[KIS] accessToken 발급 완료'))
      .catch(e => {
        const status = e.response?.status;
        console.error(`[KIS] accessToken 실패 (HTTP ${status ?? '-'}):`, e.message);
        if (e.response?.data) console.error('[KIS] 응답 본문:', JSON.stringify(e.response.data));
        if (status === 403) {
          console.error('[KIS] 403 원인: 개발자센터 > API관리 > 접속IP관리에서 이 PC/서버 IP 등록 필요');
          console.error(`[KIS]   또는 실계좌/모의투자 키 불일치 확인`);
        }
      }),
  ]);

  const watchlistItems = getWatchlistItems();

  if (require('./src/kis/auth').getAccessToken()) await fetchKisStockPrices(watchlistItems);

  await refreshHolidays();
  setInterval(refreshHolidays, 24 * 60 * 60 * 1000);

  await fetchInitialForeignPrices(watchlistItems);
  connectEsignalNightFutures();
  refreshForex();       setInterval(refreshForex,       5000);
  refreshCommodities(); setInterval(refreshCommodities, 5000);

  if (getApprovalKey()) { startSessionMonitor(getWatchlistItems); connectKis(getWatchlistItems); }
  else console.warn('[KIS] approvalKey 없음 → WebSocket 연결 건너뜀');
});
