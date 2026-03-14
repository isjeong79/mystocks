const path = require('path');

module.exports = {
  APP_KEY:         process.env.KIS_APP_KEY,
  APP_SECRET:      process.env.KIS_APP_SECRET,
  REST_BASE:       'https://openapi.koreainvestment.com:9443',
  KIS_WS_URL:      'ws://ops.koreainvestment.com:21000',
  PORT:            process.env.PORT || 3000,
  WATCHLIST_FILE:  path.join(__dirname, '..', 'watchlist.json'),
  PUBLIC_DATA_KEY: process.env.PUBLIC_DATA_API_KEY,
};
