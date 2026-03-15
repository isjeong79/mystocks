const axios = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('../config');
const { getAccessToken } = require('../kis/auth');
const { signToDir }      = require('../utils');
const { fetchYahooV8 }   = require('./yahoo');
const state     = require('../state');
const broadcast = require('../broadcast');

async function refreshForex() {
  let data = null;
  const accessToken = getAccessToken();

  if (accessToken) {
    const today = new Date();
    const fmt   = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    try {
      const res = await axios.get(
        `${REST_BASE}/uapi/overseas-price/v1/quotations/inquire-daily-chartprice`,
        {
          headers: {
            'content-type': 'application/json',
            authorization:  `Bearer ${accessToken}`,
            appkey:          APP_KEY,
            appsecret:       APP_SECRET,
            tr_id:           'FHKST03030100',
            custtype:        'P',
          },
          params: {
            FID_COND_MRKT_DIV_CODE: 'X',
            FID_INPUT_ISCD:         'USD',
            FID_INPUT_DATE_1:       fmt(new Date(today - 7 * 86400000)),
            FID_INPUT_DATE_2:       fmt(today),
            FID_PERIOD_DIV_CODE:    'D',
          },
          timeout: 8000,
        }
      );
      const out  = res.data?.output1;
      const rate = parseFloat(out?.ovrs_nmix_prpr);
      if (rate > 0) {
        const change     = parseFloat(out.ovrs_nmix_prdy_vrss ?? 0);
        const changeRate = parseFloat(out.prdy_ctrt ?? 0);
        const sign       = out.prdy_vrss_sign ?? '3';
        data = { rate, change, changeRate, dir: signToDir(sign) };
      }
    } catch (e) {
      console.error('[KIS 환율] 실패:', e.message, e.response?.data ?? '');
    }
  }

  if (!data) {
    try {
      const r = await fetchYahooV8('USDKRW=X');
      if (r) data = { rate: r.price, change: r.change, changeRate: r.changeRate, dir: r.dir };
    } catch (e) {
      console.error('[Yahoo v8] 환율 실패:', e.message);
    }
  }

  if (!data) return;
  state.forex.USDKRW = { rate: data.rate, change: data.change, changeRate: data.changeRate };
  broadcast.broadcast({ type: 'forex', symbol: 'USDKRW', name: '원/달러 환율', rate: data.rate, change: data.change, changeRate: data.changeRate, dir: data.dir });
}

module.exports = { refreshForex };
