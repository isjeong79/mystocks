const WebSocket = require('ws');
const { isNightFuturesOpen } = require('../holidays');
const state     = require('../state');
const broadcast = require('../broadcast');

let esignalWs = null;

function connectEsignalNightFutures() {
  esignalWs = new WebSocket('wss://esignal.co.kr/proxy/8888/socket.io/?EIO=4&transport=websocket', {
    headers: {
      'Origin':     'https://esignal.co.kr',
      'Referer':    'https://esignal.co.kr/kospi200-futures-night/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  esignalWs.on('open', () => console.log('[esignal] 야간선물 소켓 연결'));

  esignalWs.on('message', raw => {
    const text = raw.toString();
    if (text.startsWith('0')) { esignalWs.send('40'); return; }
    if (text.trimEnd() === '2') { esignalWs.send('3'); return; }
    if (!text.startsWith('42')) return;
    try {
      const [eventName, payload] = JSON.parse(text.slice(2));
      if (eventName !== 'populate') return;
      const d      = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const price  = parseFloat(d.value);
      if (isNaN(price) || price <= 0) return;
      const prev       = parseFloat(d.value_day) || price;
      const change     = parseFloat(d.value_diff) || parseFloat((price - prev).toFixed(2));
      const changeRate = parseFloat(((price - prev) / prev * 100).toFixed(2));
      const dir        = price > prev ? 'up' : price < prev ? 'down' : 'flat';
      const closed     = !isNightFuturesOpen();
      state.futures.KOSPI_NIGHT = { price, change, changeRate };
      broadcast.broadcast({ type: 'futures', symbol: 'KOSPI_NIGHT', name: '코스피 야간선물', price, change, changeRate, dir, closed });
    } catch (_) {}
  });

  esignalWs.on('close', (code, reason) => {
    console.log(`[esignal] 야간선물 소켓 종료 (코드: ${code}, 이유: ${reason?.toString() || '-'}) → 10초 후 재연결`);
    setTimeout(connectEsignalNightFutures, 10000);
  });
  esignalWs.on('error', err => console.error('[esignal] 야간선물 소켓 오류:', err.message));
}

module.exports = { connectEsignalNightFutures };
