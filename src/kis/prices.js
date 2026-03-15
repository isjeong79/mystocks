const axios = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('../config');
const { getAccessToken } = require('./auth');
const { getUsMarketSession, SESSION_MARKET_MAP } = require('./session');
const { getDomesticStatus } = require('../market/status');
const { signToDir, delay, getKstNow } = require('../utils');
const state     = require('../state');
const broadcast = require('../broadcast');

async function fetchKisStockPrices(watchlistItems) {
  const accessToken = getAccessToken();
  const dsStatus    = getDomesticStatus().status;
  const isAuction   = dsStatus === 'opening_auction' || dsStatus === 'closing_auction';

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
        // 동시호가 구간: stck_prpr(현재가)가 0일 수 있으므로 antc_cntg_prpr(예상체결가) 우선 사용
        const rawPrice = (isAuction && parseFloat(out.antc_cntg_prpr) > 0)
          ? out.antc_cntg_prpr
          : out.stck_prpr;
        const price = parseFloat(rawPrice);
        if (!price) { await delay(500); continue; }

        const sign       = (isAuction && out.antc_cntg_vrss_sign) ? out.antc_cntg_vrss_sign : out.prdy_vrss_sign;
        const change     = parseFloat((isAuction && out.antc_cntg_vrss)  ? out.antc_cntg_vrss  : out.prdy_vrss);
        const changeRate = parseFloat((isAuction && out.antc_cntg_ctrt)  ? out.antc_cntg_ctrt  : out.prdy_ctrt);
        const dir        = signToDir(sign);
        state.stocks[item.code] = { ...state.stocks[item.code], price, sign, change, changeRate, dir };
        broadcast.broadcast({ type: 'stock', code: item.code, price, sign, change, changeRate, dir });
      }
    } catch (e) {
      console.error(`[KIS REST] ${item.name} 실패:`, e.message, e.response?.data ?? '');
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
      params: { AUTH: '', EXCD: SESSION_MARKET_MAP[market]?.[getUsMarketSession()]?.[1] ?? market, SYMB: symbol },
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
      console.error(`[KIS REST] 해외주식 ${item.symbol} 실패:`, e.message, e.response?.data ?? '');
    }
    await delay(400);
  }
  console.log('[KIS REST] 해외주식 초기가격 완료');
}

// ── 국내 지수 초기 조회 (KOSPI: 0001, KOSDAQ: 1001) ─────────────────────────
async function fetchKisIndexPrices() {
  const accessToken = getAccessToken();
  if (!accessToken) return;

  const targets = [
    { code: '0001', key: 'KOSPI'  },
    { code: '1001', key: 'KOSDAQ' },
  ];

  // 장전단일가 등 당일 데이터가 없을 경우를 위해 5일 범위로 조회
  const kst      = getKstNow();
  const todayStr = kst.toISOString().slice(0, 10).replace(/-/g, '');
  const fromDate = new Date(kst.getTime() - 5 * 24 * 3600000);
  const fromStr  = fromDate.toISOString().slice(0, 10).replace(/-/g, '');

  for (const { code, key } of targets) {
    try {
      const res = await axios.get(
        `${REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-index-price`,
        {
          headers: {
            'content-type': 'application/json',
            authorization:  `Bearer ${accessToken}`,
            appkey:          APP_KEY,
            appsecret:       APP_SECRET,
            tr_id:           'FHKUP03500100',
            custtype:        'P',
          },
          params: {
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD:         code,
            FID_INPUT_DATE_1:       fromStr,
            FID_INPUT_DATE_2:       todayStr,
            FID_PERIOD_DIV_CODE:    'D',
            FID_ORG_ADJ_PRC:        '0',
          },
          timeout: 8000,
        }
      );
      if (res.data?.rt_cd !== '0') { console.warn(`[KIS REST] 지수 ${key} 오류:`, res.data?.msg1); continue; }

      // output1(단일 객체) 또는 output2(배열, 최신순) 모두 지원
      const out = res.data?.output ?? res.data?.output1 ?? res.data?.output2?.[0];
      if (!out) continue;

      const rawPrice = out.bstp_nmix_prpr ?? out.bstp_index_prpr ?? out.stck_prpr;
      if (!rawPrice || rawPrice === '0') continue;
      const price      = parseFloat(rawPrice);
      const change     = parseFloat(out.bstp_nmix_prdy_vrss ?? out.bstp_index_prdy_vrss ?? out.prdy_vrss ?? 0);
      const changeRate = parseFloat(out.bstp_nmix_prdy_ctrt ?? out.bstp_index_prdy_ctrt ?? out.prdy_ctrt ?? 0);
      const dir        = signToDir(out.prdy_vrss_sign);
      state.indices[key] = { price, change, changeRate, dir };
      broadcast.broadcast({ type: 'index', key, price, change, changeRate, dir });
    } catch (e) {
      console.error(`[KIS REST] 지수 ${key} 실패:`, e.message, e.response?.data ?? '');
    }
    await delay(300);
  }
  console.log('[KIS REST] 국내지수 초기가격 완료');
}

module.exports = { fetchKisStockPrices, fetchKisForeignPrice, fetchInitialForeignPrices, fetchKisIndexPrices };
