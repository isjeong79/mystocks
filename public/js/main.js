/**
 * 앱 진입점
 * - 모든 모듈 초기화 및 의존성 주입
 * - WebSocket 연결 및 메시지 라우팅
 */

import { appState }    from './state.js';
import { calcDir }     from './utils.js';
import * as WS         from './ws.js';
import * as Render     from './render.js';
import * as Modal      from './modal.js';
import * as MarketFloat from './market-float.js';
import * as Auth       from './auth.js';
import * as News       from './news.js';

// ── WebSocket URL ──────────────────────────────────────────────────────────
const WS_BASE = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
})();

function wsUrl() {
  return appState.currentUser
    ? `${WS_BASE}?userId=${appState.currentUser.userId}`
    : WS_BASE;
}

// ── 메시지 라우팅 ──────────────────────────────────────────────────────────
const noticeEl  = document.getElementById('market-notice');
const btnUpdate = document.getElementById('btn-update-stocks');
const updateStatus = document.getElementById('update-status');

function onMessage(msg) {
  switch (msg.type) {
    case 'init':
      Render.renderWatchlist(msg.watchlist || []);
      if (msg.state?.forex?.USDKRW?.rate != null) {
        const d = msg.state.forex.USDKRW;
        Render.updateForex({ ...d, dir: calcDir(d.change) });
      }
      if (msg.state?.commodities?.WTI?.price != null) {
        const d = msg.state.commodities.WTI;
        Render.updateCommodity({ symbol: 'WTI', ...d, dir: calcDir(d.change) });
      }
      if (msg.state?.commodities?.BRENT?.price != null) {
        const d = msg.state.commodities.BRENT;
        Render.updateCommodity({ symbol: 'BRENT', ...d, dir: calcDir(d.change) });
      }
      if (msg.state?.futures?.KOSPI_NIGHT?.price != null) {
        const d = msg.state.futures.KOSPI_NIGHT;
        Render.updateFutures({ ...d, dir: calcDir(d.change) });
      }
      if (msg.state?.indices?.KOSPI?.price  != null) Render.updateIndex({ key: 'KOSPI',  ...msg.state.indices.KOSPI });
      if (msg.state?.indices?.KOSDAQ?.price != null) Render.updateIndex({ key: 'KOSDAQ', ...msg.state.indices.KOSDAQ });
      if (msg.marketStatus) MarketFloat.update(msg.marketStatus);
      break;

    case 'watchlist_updated':
      Render.renderWatchlist(msg.watchlist);
      break;

    case 'stock':
      Render.updateStockCard(msg);
      noticeEl.style.display = 'none';
      break;

    case 'us_etf':    Render.updateEtfCard(msg);   break;
    case 'commodity': Render.updateCommodity(msg); break;
    case 'forex':     Render.updateForex(msg);     break;
    case 'futures':   Render.updateFutures(msg);   break;
    case 'index':     Render.updateIndex(msg);     break;

    case 'market_status':
      MarketFloat.update(msg);
      break;

    case 'market_closed':
      noticeEl.textContent   = msg.message;
      noticeEl.style.display = 'block';
      break;

    case 'stock_update_progress':
      updateStatus.textContent = msg.message.replace('[종목로더] ', '');
      break;

    case 'news_ticker':
      News.renderNewsTicker(msg.items);
      break;

    case 'stock_update_done':
      btnUpdate.disabled = false;
      updateStatus.textContent = msg.success
        ? `완료: 국내 ${msg.stats.domestic}개, 해외 ${msg.stats.foreign}개`
        : `오류: ${msg.message}`;
      break;
  }
}

// ── 종목 업데이트 버튼 ─────────────────────────────────────────────────────
btnUpdate.onclick = async () => {
  if (!confirm('업데이트 하시겠습니까?')) return;
  btnUpdate.disabled = true;
  updateStatus.textContent = '업데이트 시작 중...';
  try {
    await fetch('/api/stocks/update', { method: 'POST' });
    updateStatus.textContent = '다운로드 중... (완료 시 알림)';
  } catch {
    updateStatus.textContent = '요청 실패';
    btnUpdate.disabled = false;
  }
};

// ── 모듈 초기화 ────────────────────────────────────────────────────────────
WS.init({ getUrl: wsUrl, onMessage });

Render.init({
  openModal: Modal.openModal,
  sendWS:    WS.send,
});

Modal.init({ sendWS: WS.send });

MarketFloat.init();

News.showTickerLoading();
News.startKeepalive();
News.startVisibilityFix();

Auth.init({
  reconnectWS: WS.reconnect,
  onLogout:    null,
});

// ── 시작 ──────────────────────────────────────────────────────────────────
Auth.initAuth().then(() => {
  if (!appState.currentUser) WS.connect();
});
