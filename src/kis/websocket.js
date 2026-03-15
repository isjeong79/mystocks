const WebSocket = require('ws');
const { KIS_WS_URL } = require('../config');
const { getApprovalKey } = require('./auth');
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
    items.filter(w => w.type === 'domestic').forEach(w => kisWs.send(subMsg('H0STCNT0', w.code)));
    items.filter(w => w.type === 'foreign').forEach(w => {
      const trKey = foreignTrKey(w.market ?? 'NAS', w.symbol);
      console.log(`[KIS WS] 해외주식 구독: HDFSCNT0 ${trKey}`);
      kisWs.send(subMsg('HDFSCNT0', trKey));
    });
    kisWs.send(subMsg('H0FOREXS', 'FX@USD'));
    // 코스피/코스닥 지수 실시간 구독
    kisWs.send(subMsg('H0STASP0', '0001'));
    kisWs.send(subMsg('H0STASP0', '1001'));
  });

  kisWs.on('message', data => {
    const text = data.toString();

    if (text.startsWith('{')) {
      try {
        const json = JSON.parse(text);
        const trId = json.header?.tr_id;
        if (trId === 'PINGPONG') {
          kisWs.send(text);
        } else {
          console.log(`[KIS WS JSON] tr_id=${trId}`, JSON.stringify(json.body ?? json).substring(0, 250));
        }
      } catch (_) {}
      return;
    }

    const parts = text.split('|');
    if (parts.length < 4) return;
    const trId = parts[1], f = parts[3].split('^');

    if (trId === 'H0STCNT0') {
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

    } else if (trId === 'H0STASP0') {
      // 국내지수 실시간체결: f[0]=업종코드, f[2]=현재지수, f[3]=부호, f[4]=전일대비, f[5]=등락률
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
