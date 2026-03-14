const axios = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('../config');
const { getAccessToken } = require('./auth');
const { signToDir, delay } = require('../utils');
const state     = require('../state');
const broadcast = require('../broadcast');

async function fetchKisStockPrices(watchlistItems) {
  const accessToken = getAccessToken();
  for (const item of watchlistItems.filter(w => w.type === 'domestic')) {
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
          params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: item.code },
        }
      );
      const out = res.data?.output;
      if (out) {
        const price = parseFloat(out.stck_prpr), sign = out.prdy_vrss_sign;
        const change = parseFloat(out.prdy_vrss), changeRate = parseFloat(out.prdy_ctrt);
        const dir    = signToDir(sign);
        state.stocks[item.code] = { ...state.stocks[item.code], price, sign, change, changeRate, dir };
        broadcast.broadcast({ type: 'stock', code: item.code, price, sign, change, changeRate, dir });
      }
    } catch (e) {
      console.error(`[KIS REST] ${item.name} 실패:`, e.message);
    }
    await delay(500);
  }
}

async function fetchKisForeignPrice(market, symbol) {
  const accessToken = getAccessToken();
  const res = await axios.get(
    `${REST_BASE}/uapi/overseas-price/v1/quotations/price`,
    {
      headers: {
        'content-type': 'application/json',
        authorization:  `Bearer ${accessToken}`,
        appkey:          APP_KEY,
        appsecret:       APP_SECRET,
        tr_id:           'HHDFS00000300',
        custtype:        'P',
      },
      params: { AUTH: '', EXCD: market, SYMB: symbol },
      timeout: 8000,
    }
  );
  const out = res.data?.output;
  if (!out?.last) return null;
  const price      = parseFloat(out.last);
  const sign       = out.sign;
  const change     = parseFloat(out.diff);
  const changeRate = parseFloat(out.rate);
  return { price, sign, change, changeRate, dir: signToDir(sign) };
}

async function fetchInitialForeignPrices(watchlistItems) {
  if (!getAccessToken()) return;
  for (const item of watchlistItems.filter(w => w.type === 'foreign')) {
    try {
      const data = await fetchKisForeignPrice(item.market ?? 'NAS', item.symbol);
      if (data) {
        state.usEtfs[item.symbol] = { ...state.usEtfs[item.symbol], ...data };
        broadcast.broadcast({ type: 'us_etf', symbol: item.symbol, name: item.name, ...data });
      }
    } catch (e) {
      console.error(`[KIS REST] 해외주식 ${item.symbol} 실패:`, e.message);
    }
    await delay(400);
  }
  console.log('[KIS REST] 해외주식 초기가격 완료');
}

module.exports = { fetchKisStockPrices, fetchKisForeignPrice, fetchInitialForeignPrices };
