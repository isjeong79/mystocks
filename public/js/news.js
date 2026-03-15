/**
 * 실시간 뉴스 전광판 모듈
 * - WS 'news_ticker' 메시지 수신 → DOM 업데이트
 * - CSS translateX 기반 무한 스크롤 (seamless loop = 콘텐츠 2벌 복제)
 * - hover → 일시정지 (CSS animation-play-state: paused)
 * - 클릭 → 원문 새 창
 * - Render Sleep 방지 keepalive (5분 주기 /ping)
 */

'use strict';

// ── 상수 ─────────────────────────────────────────────────────────────────────

const TRACK_LABELS = {
  global:      '🌐 해외',
  domestic:    '🇰🇷 국내',
  disclosure:  '📋 공시',
};
const TICKER_MIN_DURATION  = 30;   // 초
const TICKER_MAX_DURATION  = 180;  // 초
const KEEPALIVE_INTERVAL   = 5 * 60 * 1000; // 5분

// ── Keep-alive ────────────────────────────────────────────────────────────────

export function startKeepalive() {
  setInterval(async () => {
    try { await fetch('/ping'); } catch (_) {}
  }, KEEPALIVE_INTERVAL);
}

// ── 탭 전환 후 애니메이션 복구 ────────────────────────────────────────────────

export function startVisibilityFix() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const track = document.getElementById('news-ticker-track');
    if (!track) return;
    // animation이 실제로 동작 중인 경우에만 재시작 (loading 상태 제외)
    const current = track.style.animationDuration;
    if (!current) return;
    track.style.animation = 'none';
    void track.offsetWidth;
    track.style.animation = '';
    track.style.animationDuration = current;
  });
}

// ── 렌더링 ────────────────────────────────────────────────────────────────────

/**
 * 뉴스 아이템 배열을 받아 ticker DOM 업데이트 + 애니메이션 재시작
 * @param {Array<{newsId, title, source, url, track, timestamp}>} items
 */
export function renderNewsTicker(items) {
  const track = document.getElementById('news-ticker-track');
  if (!track || !items?.length) return;

  const sep  = '<span class="ticker-dot" aria-hidden="true">◆</span>';
  const html = items.map(item => buildTickerItem(item)).join(sep);

  // 1단계: 세트 1개만 렌더링해서 실제 픽셀 너비를 측정
  track.style.animation = 'none';
  track.innerHTML = `<span class="ticker-set">${html}</span>`;
  void track.offsetWidth;  // reflow 강제

  const setWidth = track.querySelector('.ticker-set').offsetWidth;

  // 2단계: 세트 2개로 복제 + 측정한 픽셀값을 CSS 변수로 전달 → 정확한 루프
  track.innerHTML = `<span class="ticker-set">${html}</span>` +
                    `<span class="ticker-set" aria-hidden="true">${html}</span>`;
  track.style.setProperty('--set-width', `${setWidth}px`);

  // 애니메이션 속도: 픽셀/초 기준 (120px/s 고정)
  const duration = Math.min(TICKER_MAX_DURATION,
                   Math.max(TICKER_MIN_DURATION, setWidth / 120));
  track.style.animationDuration = `${duration}s`;

  // 애니메이션 재시작
  void track.offsetWidth;
  track.style.animation = '';

  // 클릭 이벤트 위임
  track.onclick = e => {
    const item = e.target.closest('.ticker-item');
    if (item?.dataset.url) window.open(item.dataset.url, '_blank', 'noopener');
  };
}

/**
 * 뉴스 초기 로딩 상태 표시
 */
export function showTickerLoading() {
  const track = document.getElementById('news-ticker-track');
  if (track) track.innerHTML =
    '<span class="ticker-set"><span class="ticker-item ticker-loading">글로벌 뉴스 불러오는 중...</span></span>';
}

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────────

function buildTickerItem(item) {
  const label = TRACK_LABELS[item.track] ?? '';
  const url   = escAttr(item.url || '#');
  const title = escHtml(item.title || '');
  const src   = escHtml(item.source || '');
  const time  = formatTickerTime(item.timestamp);

  return `<span class="ticker-item" data-url="${url}" role="link" tabindex="0"
    title="${escAttr(item.title)}"
  ><span class="ticker-track-label">${label}</span
  ><span class="ticker-source">${src}</span
  ><span class="ticker-title">${title}</span
  ><span class="ticker-time">${time}</span
  ></span>`;
}

function formatTickerTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
