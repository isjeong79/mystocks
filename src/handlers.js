const axios = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('./config');
const { getAccessToken } = require('./kis/auth');
const { kisMarket, foreignTrKey } = require('./kis/session');
const { fetchKisForeignPrice }    = require('./kis/prices');
const { subscribe, unsubscribe }  = require('./kis/websocket');
const { signToDir }               = require('./utils');
const { saveWatchlist, getWatchlistItems, setWatchlistItems, getWatchlistWithPrices } = require('./watchlist');
const state     = require('./state');
const broadcast = require('./broadcast');

async function handleAddStock({ stockType, code, symbol, name, exchange }) {
  const accessToken   = getAccessToken();
  const watchlistItems = getWatchlistItems();

  if (stockType === 'domestic') {
    if (state.stocks[code]) return;
    state.stocks[code] = { name, code, price: null, change: null, changeRate: null, sign: '3', dir: 'flat' };
    watchlistItems.push({ type: 'domestic', code, name });
    saveWatchlist();
    subscribe('H0STCNT0', code);
    if (accessToken) {
      try {
        const res = await axios.get(
          `${REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`,
          {
            headers: {
              'content-type': 'application/json',
              authorization:  `Bearer ${accessToken}`,
              appkey:          APP_KEY,
              appsecret:       APP_SECRET,
              tr_id:           'FHKST01010100',
              custtype:        'P',
            },
            params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
          }
        );
        const out = res.data?.output;
        if (out) {
          const price = parseFloat(out.stck_prpr), sign = out.prdy_vrss_sign;
          state.stocks[code] = { ...state.stocks[code], price, sign, change: parseFloat(out.prdy_vrss), changeRate: parseFloat(out.prdy_ctrt), dir: signToDir(sign) };
        }
      } catch (_) {}
    }
  } else {
    if (state.usEtfs[symbol]) return;
    const market = kisMarket(exchange, symbol);
    state.usEtfs[symbol] = { name, symbol, price: null, change: null, changeRate: null, dir: 'flat' };
    watchlistItems.push({ type: 'foreign', symbol, name, market });
    saveWatchlist();
    subscribe('HDFSCNT0', foreignTrKey(market, symbol));
    if (accessToken) {
      try {
        const data = await fetchKisForeignPrice(market, symbol);
        if (data) state.usEtfs[symbol] = { ...state.usEtfs[symbol], ...data };
      } catch (_) {}
    }
  }

  broadcast.broadcast({ type: 'watchlist_updated', watchlist: getWatchlistWithPrices() });
}

function handleRemoveStock({ stockType, code, symbol }) {
  const watchlistItems = getWatchlistItems();

  if (stockType === 'domestic') {
    delete state.stocks[code];
    setWatchlistItems(watchlistItems.filter(w => !(w.type === 'domestic' && w.code === code)));
    saveWatchlist();
    unsubscribe('H0STCNT0', code);
  } else {
    const item   = watchlistItems.find(w => w.type === 'foreign' && w.symbol === symbol);
    const market = item?.market ?? 'NAS';
    delete state.usEtfs[symbol];
    setWatchlistItems(watchlistItems.filter(w => !(w.type === 'foreign' && w.symbol === symbol)));
    saveWatchlist();
    unsubscribe('HDFSCNT0', foreignTrKey(market, symbol));
  }

  broadcast.broadcast({ type: 'watchlist_updated', watchlist: getWatchlistWithPrices() });
}

module.exports = { handleAddStock, handleRemoveStock };
