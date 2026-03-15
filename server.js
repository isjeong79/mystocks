require('dotenv').config();

const http = require('http');
const WebSocket = require('ws');
const path  = require('path');
const fs    = require('fs');
const url   = require('url');

const { APP_KEY, APP_SECRET, PORT } = require('./src/config');
if (!APP_KEY || !APP_SECRET) { console.error('환경변수 KIS_APP_KEY, KIS_APP_SECRET 필요'); process.exit(1); }

const { connectDB }     = require('./src/db/connection');
const { updateAllStocks, ensureStocksLoaded } = require('./src/db/stockLoader');
const { searchDomesticFromDB, searchForeignFromDB } = require('./src/db/search');
const { registerUser, loginUser, getUserById } = require('./src/db/userService');

const state     = require('./src/state');
const broadcast = require('./src/broadcast');
const watchlist = require('./src/watchlist');
const { handleAddStock, handleRemoveStock } = require('./src/handlers');
const { fetchApprovalKey, fetchAccessToken, getApprovalKey, getAccessToken } = require('./src/kis/auth');
const { fetchKisStockPrices, fetchInitialForeignPrices, fetchKisIndexPrices } = require('./src/kis/prices');
const { connectKis, startSessionMonitor } = require('./src/kis/websocket');
const { refreshCommodities } = require('./src/market/commodities');
const { refreshForex }       = require('./src/market/forex');
const { connectEsignalNightFutures } = require('./src/futures/esignal');
const { refreshHolidays }    = require('./src/holidays');
const { getAllMarketStatus, getDomesticStatus, isDomesticOpen, isDomesticAfterHours } = require('./src/market/status');
const { aggregateAndSave, queryLatestNews } = require('./src/news/aggregator');

// ── JSON body 파서 ────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ── HTTP 서버 ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── 정적 파일 ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── 사용자 등록 ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const { username } = await parseBody(req);
    if (!username?.trim()) return jsonRes(res, 400, { error: '사용자명을 입력하세요.' });
    const result = await registerUser(username);
    return jsonRes(res, result.error ? 400 : 200, result);
  }

  // ── 사용자 로그인 ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const { username } = await parseBody(req);
    if (!username?.trim()) return jsonRes(res, 400, { error: '사용자명을 입력하세요.' });
    const result = await loginUser(username);
    return jsonRes(res, result.error ? 400 : 200, result);
  }

  // ── 사용자 확인 ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const userId = parsed.query.userId;
    if (!userId) return jsonRes(res, 400, { error: 'userId 필요' });
    const user = await getUserById(userId);
    return jsonRes(res, user ? 200 : 404, user ?? { error: '사용자 없음' });
  }

  // ── 종목 검색 ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/search') {
    const q    = parsed.query.q    ?? '';
    const type = parsed.query.type ?? 'domestic';
    if (!q.trim()) return jsonRes(res, 200, []);
    try {
      const results = type === 'domestic'
        ? await searchDomesticFromDB(q)
        : await searchForeignFromDB(q);
      return jsonRes(res, 200, results);
    } catch (e) {
      console.error('[Search] 실패:', e.message);
      return jsonRes(res, 200, []);
    }
  }

  // ── 종목 데이터 업데이트 ────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/stocks/update') {
    // 비동기로 실행하고 즉시 응답 → 진행 상황은 WebSocket으로 전달
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '종목 데이터 업데이트를 시작했습니다.' }));
    updateAllStocks(msg => {
      console.log(msg);
      broadcast.broadcast({ type: 'stock_update_progress', message: msg });
    }).then(stats => {
      broadcast.broadcast({ type: 'stock_update_done', success: true, stats });
    }).catch(err => {
      console.error('[종목로더] 업데이트 오류:', err.message);
      broadcast.broadcast({ type: 'stock_update_done', success: false, message: err.message });
    });
    return;
  }

  // ── 정적 파일 (css/, js/) ──────────────────────────────────────────────
  if (req.method === 'GET' && (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/img/'))) {
    const filePath = path.join(__dirname, 'public', pathname);
    const ext = path.extname(pathname);
    const mime = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript'
      : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.svg' ? 'image/svg+xml' : ext === '.webp' ? 'image/webp' : 'text/plain';
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      res.end(data);
    });
    return;
  }

  // ── Keep-alive ping (Render Sleep 방지) ──────────────────────────────────
  if (req.method === 'GET' && pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  res.writeHead(404); res.end();
});

// ── 브라우저 WebSocket ────────────────────────────────────────────────────────
const clientWss = new WebSocket.Server({ server });
broadcast.init(clientWss);

// 마지막 수집 뉴스 캐시 (새 접속자에게 즉시 전송)
let lastNewsItems = [];

clientWss.on('connection', async (ws, req) => {
  // userId는 WS URL 쿼리스트링으로 전달: ws://host?userId=xxx
  const qs     = url.parse(req.url, true).query;
  const userId = qs.userId || null;

  console.log(`브라우저 접속${userId ? ` (userId: ${userId})` : ' (비로그인)'}`);

  // 접속 시 토큰 유효성 검증 → 만료 시 재발급
  try { await fetchAccessToken(); } catch (e) { console.error('[KIS] 접속 시 토큰 갱신 실패:', e.message); }

  const userItems  = await watchlist.getWatchlistForUser(userId);
  ws.send(JSON.stringify({ type: 'init', state, watchlist: watchlist.buildWithPrices(userItems), marketStatus: getAllMarketStatus() }));

  // 캐시된 뉴스가 있으면 접속 즉시 전송 (2분 인터벌 기다릴 필요 없음)
  if (lastNewsItems.length > 0) {
    ws.send(JSON.stringify({ type: 'news_ticker', items: lastNewsItems }));
  }

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'add_stock') {
        const updated = await handleAddStock(msg, userId);
        ws.send(JSON.stringify({ type: 'watchlist_updated', watchlist: updated }));
      } else if (msg.type === 'remove_stock') {
        const updated = await handleRemoveStock(msg, userId);
        ws.send(JSON.stringify({ type: 'watchlist_updated', watchlist: updated }));
      }
    } catch (e) { console.error('[WS] 메시지 처리 오류:', e.message); }
  });

  ws.on('close', () => console.log('브라우저 해제'));
});

// ── 시작 ──────────────────────────────────────────────────────────────────────
async function main() {
  // 1. MongoDB 연결
  await connectDB();

  // 2. 워치리스트 및 state 초기화
  watchlist.initDefaultState();
  await watchlist.loadAllWatchlists();

  // 3. 서버 시작
  server.listen(PORT, async () => {
    console.log(`서버 오픈: 포트 ${PORT}`);

    // 4. KIS 인증
    await Promise.allSettled([
      fetchApprovalKey()
        .then(() => console.log('[KIS] approvalKey 발급 완료'))
        .catch(e => {
          console.error('[KIS] approvalKey 실패:', e.message);
        }),
      fetchAccessToken()
        .then(() => console.log('[KIS] accessToken 발급 완료'))
        .catch(e => {
          const status = e.response?.status;
          console.error(`[KIS] accessToken 실패 (HTTP ${status ?? '-'}):`, e.message);
          if (status === 403) {
            console.error('[KIS] 403 원인: 접속IP 미등록 또는 키 불일치');
          }
        }),
    ]);

    const allItems = watchlist.getWatchlistItems();

    if (getAccessToken()) {
      await fetchKisStockPrices(allItems);
      await fetchKisIndexPrices();
    }

    // 공휴일 로드는 백그라운드 실행 (API 수십 건 → await 시 KIS 연결·상태 인터벌 블록)
    refreshHolidays().catch(e => console.error('[공휴일] 초기 로드 실패:', e.message));
    setInterval(refreshHolidays, 24 * 60 * 60 * 1000);

    await fetchInitialForeignPrices(allItems);
    connectEsignalNightFutures();
    refreshForex();       setInterval(refreshForex,       5000);
    refreshCommodities(); setInterval(refreshCommodities, 5000);

    // 시장 상태 1초마다 체크 → 변경 시 브로드캐스트 + closed 전환 시 최종 종가 1회 조회
    let _lastStatusKey = '';
    setInterval(async () => {
      const status = getAllMarketStatus();
      const key = `${status.domestic.status}|${status.us.status}|${status.futures.status}`;
      if (key !== _lastStatusKey) {
        _lastStatusKey = key;
        console.log(`[시장상태] ${key}`);
        broadcast.broadcast({ type: 'market_status', ...status });

        // closed_wait(15:30) 또는 closed(18:00) 진입 시 → 최종 종가 1회 조회
        const ds = status.domestic.status;
        if ((ds === 'closed_wait' || ds === 'closed') && getAccessToken()) {
          console.log(`[KIS REST] ${ds} 전환 → 최종 종가 1회 조회`);
          fetchKisStockPrices(watchlist.getWatchlistItems()).catch(() => {});
          fetchKisIndexPrices().catch(() => {});
        }
      }
    }, 1000);

    // accessToken 23시간마다 갱신 (KIS 토큰 유효기간 24시간)
    setInterval(async () => {
      try {
        await fetchAccessToken(true);
        console.log('[KIS] accessToken 자동 갱신 완료');
      } catch (e) {
        console.error('[KIS] accessToken 자동 갱신 실패:', e.message);
      }
    }, 23 * 60 * 60 * 1000);

    // 국내 종목·지수 REST 폴링 — 상태별 주기 분기
    // open/pre/동시호가: 1분(지수), 5분(종목) / after(시간외단일가): 10분 / closed_wait·closed: 폴링 없음
    let _lastRestMin = -1;
    setInterval(async () => {
      if (!getAccessToken()) return;
      const ds  = getDomesticStatus().status;
      if (ds === 'closed' || ds === 'closed_wait') return;

      const now = new Date();
      const min = now.getHours() * 60 + now.getMinutes();
      if (min === _lastRestMin) return; // 동일 분 중복 실행 방지
      _lastRestMin = min;

      // 지수: 1분마다 (after 제외 — 지수는 시간외단일가 구간엔 의미 없음)
      if (ds !== 'after') {
        await fetchKisIndexPrices().catch(() => {});
      }

      // 종목: open/pre/auction→5분, after→10분
      const interval = ds === 'after' ? 10 : 5;
      if (min % interval === 0) {
        await fetchKisStockPrices(watchlist.getWatchlistItems()).catch(() => {});
      }
    }, 60 * 1000);


    // KIS WS 연결 (approvalKey 없으면 2분마다 재시도)
    let _kisStarted = false;
    const _tryConnectKis = () => {
      if (_kisStarted) return;
      if (getApprovalKey()) {
        _kisStarted = true;
        startSessionMonitor(watchlist.getWatchlistItems);
        connectKis(watchlist.getWatchlistItems);
      }
    };
    _tryConnectKis();
    if (!_kisStarted) {
      console.warn('[KIS] approvalKey 없음 → 2분마다 재시도');
      const _kisRetry = setInterval(async () => {
        if (_kisStarted) { clearInterval(_kisRetry); return; }
        try {
          await fetchApprovalKey();
          console.log('[KIS] approvalKey 재발급 완료');
        } catch (e) {
          console.warn('[KIS] approvalKey 재시도 실패:', e.message); return;
        }
        _tryConnectKis();
        if (_kisStarted) clearInterval(_kisRetry);
      }, 2 * 60 * 1000);
    }

    // 5. 종목 DB 확인 (백그라운드)
    ensureStocksLoaded().catch(e => console.error('[종목로더]', e.message));

    // 6. 뉴스 수집: 즉시 첫 실행, 이후 2분 주기 (RSS 수집 + DB 저장)
    const runNewsAggregator = async () => {
      try {
        const items = await aggregateAndSave();
        if (items.length > 0) {
          lastNewsItems = items;
          broadcast.broadcast({ type: 'news_ticker', items });
          console.log(`[News] 브로드캐스트: ${items.length}건`);
        }
      } catch (e) {
        console.error('[News] 수집 오류:', e.message);
      }
    };
    runNewsAggregator();
    setInterval(runNewsAggregator, 2 * 60 * 1000); // 2분 주기

    // 7. 뉴스 즉시 반영: 30초마다 DB 조회 → 새 기사 있으면 즉시 브로드캐스트
    // (RSS 수집 없이 DB만 조회하므로 가볍고 빠름)
    let _lastNewsKey = '';
    setInterval(async () => {
      try {
        const items = await queryLatestNews();
        if (items.length === 0) return;
        const key = items.map(i => i.newsId).join(',');
        if (key === _lastNewsKey) return; // 변화 없으면 스킵
        _lastNewsKey = key;
        lastNewsItems = items;
        broadcast.broadcast({ type: 'news_ticker', items });
        console.log(`[News] 티커 갱신 (30s): ${items.length}건`);
      } catch (e) {
        console.error('[News] 티커 갱신 오류:', e.message);
      }
    }, 30 * 1000); // 30초 주기
  });
}

main().catch(e => { console.error('서버 시작 실패:', e); process.exit(1); });
