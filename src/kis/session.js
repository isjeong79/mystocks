const { getKstNow } = require('../utils');

const YAHOO_TO_KIS_MARKET = {
  'NMS': 'NAS', 'NGM': 'NAS', 'NCM': 'NAS',
  'NYQ': 'NYS',
  'PCX': 'AMS', 'ASE': 'AMS',
};

const DEFAULT_MARKET = {
  QQQ: 'NAS', AAPL: 'NAS', MSFT: 'NAS', NVDA: 'NAS', AMZN: 'NAS',
  GOOG: 'NAS', GOOGL: 'NAS', META: 'NAS', TSLA: 'NAS', NFLX: 'NAS',
  AMD: 'NAS', INTC: 'NAS', ADBE: 'NAS',
  SPY: 'AMS', DIA: 'AMS', IWM: 'AMS', GLD: 'AMS', SLV: 'AMS',
  EFA: 'AMS', EEM: 'AMS', VTI: 'AMS', VOO: 'AMS', AGG: 'AMS',
  TLT: 'AMS', QLD: 'AMS', TQQQ: 'NAS',
};

const SESSION_MARKET_MAP = {
  NAS: { night: ['D', 'NAS'], day: ['R', 'BAQ'] },
  NYS: { night: ['D', 'NYS'], day: ['R', 'BAY'] },
  AMS: { night: ['D', 'AMS'], day: ['R', 'BAA'] },
};

const KIS_MARKET_CODES = new Set(['NAS', 'NYS', 'AMS']);

function kisMarket(yahooExchange, symbol) {
  // DB에서 이미 KIS 코드로 저장된 경우 그대로 사용 (DEFAULT_MARKET 덮어쓰기 방지)
  if (KIS_MARKET_CODES.has(yahooExchange)) return yahooExchange;
  return YAHOO_TO_KIS_MARKET[yahooExchange] ?? DEFAULT_MARKET[symbol] ?? 'NAS';
}

function getUsMarketSession() {
  const now = new Date();
  const kst = getKstNow();
  const hm  = kst.getHours() * 60 + kst.getMinutes();

  const y = now.getUTCFullYear();
  const dstStart = (() => {
    let d = new Date(Date.UTC(y, 2, 1)), cnt = 0;
    while (cnt < 2) { if (d.getUTCDay() === 0) cnt++; if (cnt < 2) d.setUTCDate(d.getUTCDate() + 1); }
    return new Date(d.getTime() + 7 * 3600000);
  })();
  const dstEnd = (() => {
    let d = new Date(Date.UTC(y, 10, 1));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
    return new Date(d.getTime() + 6 * 3600000);
  })();
  const isDST = now >= dstStart && now < dstEnd;

  const nightOpen  = isDST ? 22 * 60 + 30 : 23 * 60 + 30;
  const nightClose = isDST ?  5 * 60      :  6 * 60;
  const dayOpen    = isDST ? 17 * 60      : 18 * 60;

  if (hm >= nightOpen || hm < nightClose) return 'night';
  if (hm >= dayOpen)                      return 'day';
  return 'night';
}

function foreignTrKey(market, symbol) {
  const session = getUsMarketSession();
  const [prefix, mkt] = SESSION_MARKET_MAP[market]?.[session] ?? ['D', market];
  return `${prefix}${mkt}${symbol}`;
}

module.exports = { kisMarket, getUsMarketSession, foreignTrKey, DEFAULT_MARKET };
