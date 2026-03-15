const WebSocket = require('ws');
const { KIS_WS_URL } = require('../config');
const { getApprovalKey, fetchApprovalKey } = require('./auth');
const { getUsMarketSession, foreignTrKey } = require('./session');
const { signToDir } = require('../utils');
const state     = require('../state');
const broadcast = require('../broadcast');

let kisWs = null;

function subMsg(trId, trKey) {
  return JSON.stringify({
    header: { approval_key: getApprovalKey(), custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
    body:   { input: { tr_id: trId, tr_key: trKey } },
  });
}

function unsubMsg(trId, trKey) {
  return JSON.stringify({
    header: { approval_key: getApprovalKey(), custtype: 'P', tr_type: '2', 'content-type': 'utf-8' },
    body:   { input: { tr_id: trId, tr_key: trKey } },
  });
}

function subscribe(trId, trKey) {
  if (kisWs?.readyState === WebSocket.OPEN && getApprovalKey()) {
    kisWs.send(subMsg(trId, trKey));
  }
}

function unsubscribe(trId, trKey) {
  if (kisWs?.readyState === WebSocket.OPEN && getApprovalKey()) {
    kisWs.send(unsubMsg(trId, trKey));
  }
}

function connectKis(getWatchlistItems) {
  kisWs = new WebSocket(KIS_WS_URL);

  kisWs.on('open', () => {
    console.log('[KIS WS] 연결');
    const items = getWatchlistItems();
    items.filter(w => w.type === 'domestic').forEach(w => {
      kisWs.send(subMsg('H0STCNT0', w.code)); // KRX 정규장 체결
      kisWs.send(subMsg('H1STCNT0', w.code)); // NXT 프리마켓 체결 (08:00~08:50)
      kisWs.send(subMsg('H0STASP0', w.code)); // 호가/예상체결가 (동시호가 구간)
    });
    items.filter(w => w.type === 'foreign').forEach(w => {
      const trKey = foreignTrKey(w.market ?? 'NAS', w.symbol);
      console.log(`[KIS WS] 해외주식 구독: HDFSCNT0 ${trKey}`);
      kisWs.send(subMsg('HDFSCNT0', trKey));
    });
    kisWs.send(subMsg('H0FOREXS', 'FX@USD'));
    // 코스피/코스닥 지수 실시간 구독 (국내업종 실시간 체결 TR)
    kisWs.send(subMsg('H0STCNI0', '0001')); // KOSPI 지수
    kisWs.send(subMsg('H0STCNI0', '1001')); // KOSDAQ 지수
  });

  kisWs.on('message', data => {
    const text = data.toString();

    if (text.startsWith('{')) {
      try {
        const json = JSON.parse(text);
        const trId = json.header?.tr_id;
        if (trId === 'PINGPONG') {
          kisWs.send(text);
        } else if (json.body?.msg_cd === 'OPSP0011') {
          // approvalKey 만료 → 재발급 후 재연결
          console.warn('[KIS WS] approvalKey 만료 → 재발급 후 재연결');
          fetchApprovalKey()
            .then(() => { if (kisWs?.readyState === WebSocket.OPEN) kisWs.close(); })
            .catch(e => console.error('[KIS WS] approvalKey 재발급 실패:', e.message));
        } else {
          console.log(`[KIS WS JSON] tr_id=${trId}`, JSON.stringify(json.body ?? json).substring(0, 250));
        }
      } catch (_) {}
      return;
    }

    const parts = text.split('|');
    if (parts.length < 4) return;
    const trId = parts[1], f = parts[3].split('^');

    if (trId === 'H0STCNT0' || trId === 'H1STCNT0') {
      // KRX 정규장 체결(H0STCNT0) / NXT 프리마켓 체결(H1STCNT0) — 동일 포맷
      const code = f[0];
      if (!state.stocks[code]) return;
      const price = parseFloat(f[2]), sign = f[3], change = parseFloat(f[4]), changeRate = parseFloat(f[5]), dir = signToDir(sign);
      state.stocks[code] = { ...state.stocks[code], price, sign, change, changeRate, dir };
      broadcast.broadcast({ type: 'stock', code, price, sign, change, changeRate, dir });

    } else if (trId === 'H0FOREXS' || trId === 'H0FOREXS0') {
      console.log(`[KIS WS] ${trId} 전체필드(${f.length}개):`, f.slice(0, 15));
      const rate = parseFloat(f[2]);
      if (!rate) { console.warn(`[KIS WS] rate 파싱 실패 f[2]="${f[2]}"`); return; }
      const prev       = state.forex.USDKRW.rate || rate;
      const change     = parseFloat((rate - prev).toFixed(2));
      const changeRate = parseFloat(((rate - prev) / prev * 100).toFixed(2));
      state.forex.USDKRW = { rate, change, changeRate };
      broadcast.broadcast({ type: 'forex', symbol: 'USDKRW', name: '원/달러 환율', rate, change, changeRate, dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' });

    } else if (trId === 'HDFSCNT0') {
      const rsym   = f[0] ?? '';
      const symbol = rsym.length > 4 ? rsym.substring(4) : rsym;
      if (!symbol || !state.usEtfs[symbol]) return;
      const price      = parseFloat(f[11]);
      const sign       = f[12];
      const change     = parseFloat(f[13]);
      const changeRate = parseFloat(f[14]);
      if (isNaN(price)) return;
      const dir = signToDir(sign);
      state.usEtfs[symbol] = { ...state.usEtfs[symbol], price, sign, change, changeRate, dir };
      broadcast.broadcast({ type: 'us_etf', symbol, name: state.usEtfs[symbol].name, price, change, changeRate, dir });

    } else if (trId === 'H0STCNI0') {
      // 국내 업종(지수) 실시간 체결: f[0]=업종코드, f[2]=현재지수, f[3]=부호, f[4]=전일대비, f[5]=등락률
      const code       = f[0];
      const key        = code === '0001' ? 'KOSPI' : code === '1001' ? 'KOSDAQ' : null;
      if (!key) return;
      const price      = parseFloat(f[2]);
      const sign       = f[3];
      const change     = parseFloat(f[4]);
      const changeRate = parseFloat(f[5]);
      if (isNaN(price)) return;
      const dir = signToDir(sign);
      state.indices[key] = { price, change, changeRate, dir };
      broadcast.broadcast({ type: 'index', key, price, change, changeRate, dir });

    } else if (trId === 'H0STASP0') {
      // 개별종목 호가 — 동시호가 구간의 예상체결가 사용
      // KIS 공식 명세: f[47]=예상체결가, f[50]=예상체결대비, f[51]=부호, f[52]=예상체결등락률
      const code  = f[0];
      if (!state.stocks[code]) return;
      const price = parseFloat(f[47]);
      if (!price || isNaN(price)) return;
      const sign       = f[51] ?? '3';
      const change     = parseFloat(f[50] ?? 0);
      const changeRate = parseFloat(f[52] ?? 0);
      const dir        = signToDir(sign);
      state.stocks[code] = { ...state.stocks[code], price, sign, change, changeRate, dir };
      broadcast.broadcast({ type: 'stock', code, price, sign, change, changeRate, dir });

    } else {
      console.log(`[KIS WS] 미처리 trId=${trId} fields[0-4]:`, f.slice(0, 5));
    }
  });

  kisWs.on('close', () => {
    console.log('[KIS WS] 연결 종료 → 5초 후 재연결');
    setTimeout(() => connectKis(getWatchlistItems), 5000);
  });
  kisWs.on('error', err => console.error('[KIS WS] 오류:', err.message));
}

let _lastUsSession = null;
function startSessionMonitor(getWatchlistItems) {
  _lastUsSession = getUsMarketSession();
  setInterval(() => {
    const session = getUsMarketSession();
    if (_lastUsSession !== session) {
      console.log(`[세션전환] ${_lastUsSession} → ${session} | KIS WebSocket 재연결`);
      _lastUsSession = session;
      if (kisWs?.readyState === WebSocket.OPEN) kisWs.close();
    }
  }, 60000);
}

module.exports = { connectKis, startSessionMonitor, subscribe, unsubscribe };
