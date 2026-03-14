const axios = require('axios');
const { APP_KEY, APP_SECRET, REST_BASE } = require('./config');
const { getAccessToken } = require('./kis/auth');
const { YAHOO_HEADERS }  = require('./market/yahoo');

async function searchDomesticStocks(q) {
  const trimmed     = q.trim();
  const accessToken = getAccessToken();

  if (/^\d{6}$/.test(trimmed) && accessToken) {
    try {
      const res = await axios.get(
        `${REST_BASE}/uapi/domestic-stock/v1/quotations/search-info`,
        {
          headers: {
            'content-type': 'application/json',
            authorization:  `Bearer ${accessToken}`,
            appkey:          APP_KEY,
            appsecret:       APP_SECRET,
            tr_id:           'CTPF1604R',
            custtype:        'P',
          },
          params:  { PDNO: trimmed, PRDT_TYPE_CD: '300' },
          timeout: 6000,
        }
      );
      const out = res.data?.output;
      if (out?.pdno) return [{ code: out.pdno, name: out.prdt_name || out.prdt_abrv_name || trimmed, exchange: 'KOSPI' }];
    } catch (_) {}
  }

  const res = await axios.get('https://query2.finance.yahoo.com/v1/finance/search', {
    params:  { q: trimmed, lang: 'ko-KR', region: 'KR', quotesCount: 10, newsCount: 0 },
    headers: YAHOO_HEADERS,
    timeout: 6000,
  });
  return (res.data?.quotes ?? [])
    .filter(r => r.typeDisp === 'Equity' && r.symbol && (r.symbol.endsWith('.KS') || r.symbol.endsWith('.KQ')))
    .slice(0, 10)
    .map(r => ({
      code:     r.symbol.replace(/\.(KS|KQ)$/i, ''),
      name:     r.longname || r.shortname || r.symbol,
      exchange: r.symbol.endsWith('.KS') ? 'KOSPI' : 'KOSDAQ',
    }));
}

async function searchForeignStocks(q) {
  const trimmed     = q.trim().toUpperCase();
  const accessToken = getAccessToken();

  if (/^[A-Z]{1,6}$/.test(trimmed) && accessToken) {
    for (const [mkt, prdtCd] of [['NAS','512'],['NYS','513'],['AMS','529']]) {
      try {
        const res = await axios.get(
          `${REST_BASE}/uapi/overseas-price/v1/quotations/search-info`,
          {
            headers: {
              'content-type': 'application/json',
              authorization:  `Bearer ${accessToken}`,
              appkey:          APP_KEY,
              appsecret:       APP_SECRET,
              tr_id:           'CTPF1702R',
              custtype:        'P',
            },
            params:  { PRDT_TYPE_CD: prdtCd, PDNO: trimmed },
            timeout: 5000,
          }
        );
        const out = res.data?.output;
        if (out?.std_pdno) {
          return [{ symbol: out.std_pdno, name: out.prdt_name || out.ovrs_item_name || trimmed, exchange: out.ovrs_excg_cd || mkt, typeDisp: out.ovrs_stck_dvsn_cd === '03' ? 'ETF' : 'Equity' }];
        }
      } catch (_) {}
    }
  }

  const res = await axios.get('https://query2.finance.yahoo.com/v1/finance/search', {
    params:  { q: trimmed, lang: 'en-US', region: 'US', quotesCount: 10, newsCount: 0 },
    headers: YAHOO_HEADERS,
    timeout: 6000,
  });
  return (res.data?.quotes ?? [])
    .filter(r => (r.typeDisp === 'Equity' || r.typeDisp === 'ETF') && r.symbol && !r.symbol.includes('.'))
    .slice(0, 10)
    .map(r => ({
      symbol:   r.symbol,
      name:     r.longname || r.shortname || r.symbol,
      exchange: r.exchange,
      typeDisp: r.typeDisp,
    }));
}

module.exports = { searchDomesticStocks, searchForeignStocks };
