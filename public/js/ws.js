/**
 * WebSocket 연결 관리
 * 메시지 라우팅은 main.js의 핸들러에 위임
 */

let _ws;
let _retryDelay = 1000;
let _getUrl;
let _onMessage;
let _statusEl;

export function init({ getUrl, onMessage }) {
  _getUrl    = getUrl;
  _onMessage = onMessage;
  _statusEl  = document.getElementById('status');
}

export function connect() {
  _ws = new WebSocket(_getUrl());

  _ws.onopen = () => {
    _statusEl.className = 'connected';
    _retryDelay = 1000;
  };
  _ws.onerror = () => {
    _statusEl.className = 'error';
  };
  _ws.onclose = () => {
    _statusEl.className = '';
    setTimeout(() => {
      _retryDelay = Math.min(_retryDelay * 2, 30000);
      connect();
    }, _retryDelay);
  };
  _ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    _onMessage(msg);
  };
}

export function reconnect() {
  if (_ws) { _ws.onclose = null; _ws.close(); }
  _retryDelay = 1000;
  connect();
}

export function send(msg) {
  if (_ws?.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(msg));
}
