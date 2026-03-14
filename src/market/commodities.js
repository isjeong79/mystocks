const { fetchYahooV8 } = require('./yahoo');
const state     = require('../state');
const broadcast = require('../broadcast');
const { delay } = require('../utils');

const COMMODITY_TARGETS = [
  { key: 'WTI',   name: 'WTI 원유',    yahooSym: 'CL=F' },
  { key: 'BRENT', name: '브렌트 원유', yahooSym: 'BZ=F' },
];

async function refreshCommodities() {
  for (const item of COMMODITY_TARGETS) {
    try {
      const data = await fetchYahooV8(item.yahooSym);
      if (data) {
        state.commodities[item.key] = { price: data.price, change: data.change, changeRate: data.changeRate };
        broadcast.broadcast({ type: 'commodity', symbol: item.key, name: item.name, ...data });
      }
    } catch (e) {
      console.error(`[Yahoo v8] ${item.key} 실패:`, e.message);
    }
    await delay(300);
  }
}

module.exports = { refreshCommodities };
