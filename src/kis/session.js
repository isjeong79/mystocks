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
  const kst = getKstNow();
  const hm  = kst.getHours() * 60 + kst.getMinutes();
  // KST 09:00~17:00 → 주간(대체거래소), 그 외 → 야간(프리/정규/애프터 포함)
  return (hm >= 9 * 60 && hm < 17 * 60) ? 'day' : 'night';
}

function foreignTrKey(market, symbol) {
  const session = getUsMarketSession();
  const [prefix, mkt] = SESSION_MARKET_MAP[market]?.[session] ?? ['D', market];
  return `${prefix}${mkt}${symbol}`;
}

module.exports = { kisMarket, getUsMarketSession, foreignTrKey, DEFAULT_MARKET, SESSION_MARKET_MAP };
