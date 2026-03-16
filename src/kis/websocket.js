const WebSocket = require('ws');
const { KIS_WS_URL } = require('../config');
const { getApprovalKey } = require('./auth');
const { getUsMarketSession, foreignTrKey } = require('./session');
const { getDomesticStatus } = require('../market/status');
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
    const ds = getDomesticStatus().status;
    // 구독 한도(40개) 방어: 시장 상태에 따라 종목당 TR 1개만 구독
    const domTrId = (ds === 'pre') ? 'H1STCNT0' : 'H0STCNT0';
    console.log(`[KIS WS] 국내종목 구독 TR: ${domTrId} (상태: ${ds})`);
    items.filter(w => w.type === 'domestic').forEach(w => kisWs.send(subMsg(domTrId, w.code)));
    items.filter(w => w.type === 'foreign').forEach(w => {
      const trKey = foreignTrKey(w.market ?? 'NAS', w.symbol);
      console.log(`[KIS WS] 해외주식 구독: HDFSCNT0 ${trKey}`);
      kisWs.send(subMsg('HDFSCNT0', trKey));
    });
    // kisWs.send(subMsg('H0FOREXS', 'FX@USD'));   // 권한 확인 전 비활성화
    // kisWs.send(subMsg('H0STASP0', '0001'));      // 권한 확인 전 비활성화
    // kisWs.send(subMsg('H0STASP0', '1001'));      // 권한 확인 전 비활성화
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
          console.warn('[KIS WS 거절]', trId, json.body.msg_cd, json.body.msg1);
          return;
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
      const rate = parseFloat(f[2]);
      if (!rate) return;
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
let _lastDomStatus = null;
function startSessionMonitor(getWatchlistItems) {
  _lastUsSession = getUsMarketSession();
  _lastDomStatus = getDomesticStatus().status;
  setInterval(() => {
    // 미국 세션 전환 감시
    const session = getUsMarketSession();
    if (_lastUsSession !== session) {
      console.log(`[세션전환] US ${_lastUsSession} → ${session} | KIS WS 재연결`);
      _lastUsSession = session;
      if (kisWs?.readyState === WebSocket.OPEN) kisWs.close();
      return;
    }
    // 국내 시장 상태 전환 감시 (pre↔open 경계에서 TR 변경)
    const domStatus = getDomesticStatus().status;
    if (_lastDomStatus !== domStatus) {
      console.log(`[세션전환] KR ${_lastDomStatus} → ${domStatus} | KIS WS 재연결`);
      _lastDomStatus = domStatus;
      if (kisWs?.readyState === WebSocket.OPEN) kisWs.close();
    }
  }, 60000);
}

module.exports = { connectKis, startSessionMonitor, subscribe, unsubscribe };
