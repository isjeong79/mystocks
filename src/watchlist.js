const fs   = require('fs');
const { WATCHLIST_FILE } = require('./config');
const { DEFAULT_MARKET } = require('./kis/session');
const state = require('./state');

let watchlistItems = [];

function loadWatchlist() {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      watchlistItems = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
    } else {
      watchlistItems = [
        { type: 'domestic', code: '005930', name: '삼성전자' },
        { type: 'domestic', code: '000660', name: 'SK하이닉스' },
        { type: 'domestic', code: '005380', name: '현대차' },
        { type: 'foreign', symbol: 'QQQ', name: '나스닥100(QQQ)', market: 'NAS' },
        { type: 'foreign', symbol: 'SPY', name: 'S&P500(SPY)',    market: 'AMS' },
        { type: 'foreign', symbol: 'DIA', name: '다우존스(DIA)',  market: 'AMS' },
      ];
      saveWatchlist();
    }
    let patched = false;
    watchlistItems.forEach(item => {
      if (item.type === 'foreign' && !item.market) {
        item.market = DEFAULT_MARKET[item.symbol] ?? 'NAS';
        patched = true;
      }
    });
    if (patched) saveWatchlist();
    console.log(`[Watchlist] ${watchlistItems.length}개 종목 로드`);
  } catch (e) {
    console.error('[Watchlist] 로드 실패:', e.message);
    watchlistItems = [];
  }
}

function saveWatchlist() {
  try { fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlistItems, null, 2)); }
  catch (e) { console.error('[Watchlist] 저장 실패:', e.message); }
}

function getWatchlistItems() {
  return watchlistItems;
}

function setWatchlistItems(items) {
  watchlistItems = items;
}

function getWatchlistWithPrices() {
  return watchlistItems.map(item => {
    if (item.type === 'domestic') {
      return { type: 'domestic', code: item.code, name: item.name, ...(state.stocks[item.code] ?? {}) };
    } else {
      return { type: 'foreign', symbol: item.symbol, name: item.name, ...(state.usEtfs[item.symbol] ?? {}) };
    }
  });
}

function initStateFromWatchlist() {
  for (const item of watchlistItems) {
    if (item.type === 'domestic' && !state.stocks[item.code]) {
      state.stocks[item.code] = { name: item.name, code: item.code, price: null, change: null, changeRate: null, sign: '3', dir: 'flat' };
    } else if (item.type === 'foreign' && !state.usEtfs[item.symbol]) {
      state.usEtfs[item.symbol] = { name: item.name, symbol: item.symbol, price: null, change: null, changeRate: null, dir: 'flat' };
    }
  }
}

module.exports = { loadWatchlist, saveWatchlist, getWatchlistItems, setWatchlistItems, getWatchlistWithPrices, initStateFromWatchlist };
