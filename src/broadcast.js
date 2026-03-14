const WebSocket = require('ws');

let _wss = null;

function init(wss) {
  _wss = wss;
}

function broadcast(data) {
  if (!_wss) return;
  const msg = JSON.stringify(data);
  _wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

module.exports = { init, broadcast };
