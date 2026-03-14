const axios = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('./config');
const { getAccessToken }          = require('./kis/auth');
const { kisMarket, foreignTrKey } = require('./kis/session');
const { fetchKisForeignPrice }    = require('./kis/prices');
const { subscribe, unsubscribe }  = require('./kis/websocket');
const { signToDir }               = require('./utils');
const watchlist = require('./watchlist');
const state = require('./state');

// ── 종목 추가 ────────────────────────────────────────────────────────────────
async function handleAddStock({ stockType, code, symbol, name, exchange }, userId) {
  const accessToken = getAccessToken();

  if (stockType === 'domestic') {
    if (!state.stocks[code]) {
      state.stocks[code] = { name, code, price: null, change: null, changeRate: null, sign: '3', dir: 'flat' };
      subscribe('H0STCNT0', code);
      if (accessToken) {
        try {
          const res = await axios.get(`${REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`, {
            headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, appkey: APP_KEY, appsecret: APP_SECRET, tr_id: 'FHKST01010100', custtype: 'P' },
            params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
          });
          const out = res.data?.output;
          if (out) {
            const price = parseFloat(out.stck_prpr), sign = out.prdy_vrss_sign;
            state.stocks[code] = { ...state.stocks[code], price, sign, change: parseFloat(out.prdy_vrss), changeRate: parseFloat(out.prdy_ctrt), dir: signToDir(sign) };
          }
        } catch (_) {}
      }
    }
    const updated = await watchlist.addItemToUserWatchlist(userId, { type: 'domestic', code, name });
    return watchlist.buildWithPrices(updated ?? []);

  } else {
    const market = kisMarket(exchange, symbol);
    if (!state.usEtfs[symbol]) {
      state.usEtfs[symbol] = { name, symbol, price: null, change: null, changeRate: null, dir: 'flat' };
      subscribe('HDFSCNT0', foreignTrKey(market, symbol));
      if (accessToken) {
        try {
          const data = await fetchKisForeignPrice(market, symbol);
          if (data) state.usEtfs[symbol] = { ...state.usEtfs[symbol], ...data };
        } catch (_) {}
      }
    }
    const updated = await watchlist.addItemToUserWatchlist(userId, { type: 'foreign', symbol, name, market });
    return watchlist.buildWithPrices(updated ?? []);
  }
}

// ── 종목 삭제 ────────────────────────────────────────────────────────────────
async function handleRemoveStock({ stockType, code, symbol }, userId) {
  const updated = await watchlist.removeItemFromUserWatchlist(userId, { stockType, code, symbol });
  return watchlist.buildWithPrices(updated ?? []);
}

module.exports = { handleAddStock, handleRemoveStock };
