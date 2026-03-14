const axios = require('axios');

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

async function fetchYahooV8(yahooSymbol) {
  const res = await axios.get(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
    {
      params:  { interval: '1d', range: '5d' },
      headers: YAHOO_HEADERS,
      timeout: 8000,
    }
  );
  const meta = res.data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;
  const price = meta.regularMarketPrice;
  const prev  = meta.previousClose ?? meta.chartPreviousClose ?? price;
  const change     = parseFloat((price - prev).toFixed(2));
  const changeRate = parseFloat(((price - prev) / prev * 100).toFixed(2));
  return { price, change, changeRate, dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
}

module.exports = { fetchYahooV8, YAHOO_HEADERS };
