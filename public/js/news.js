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
const TICKER_MIN_DURATION  = 40;   // 초
const KEEPALIVE_INTERVAL   = 5 * 60 * 1000; // 5분
const TICKER_UPDATE_DELAY  = 3;    // 새 기사 적용까지 기다릴 루프 수

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
    // animation 단축속성 인라인값 확인 (loading 상태 = none 이면 재시작 안 함)
    const current = track.style.animation;
    if (!current || current === 'none') return;
    track.style.animation = 'none';
    void track.offsetWidth;
    track.style.animation = current;
  });
}

// ── 지연 업데이트 (루프 완료 후 교체) ────────────────────────────────────────

let _pendingItems  = null;
let _loopCountdown = 0;

/**
 * 티커가 재생 중이면 TICKER_UPDATE_DELAY 루프 후 교체, 아니면 즉시 렌더링
 */
export function scheduleTickerUpdate(items) {
  const track = document.getElementById('news-ticker-track');
  const isPlaying = track?.style.animation && track.style.animation !== 'none';

  if (!isPlaying) {
    renderNewsTicker(items);
    return;
  }

  _pendingItems  = items;
  _loopCountdown = TICKER_UPDATE_DELAY;

  // 이미 리스너가 없으면 등록
  if (!track._iterListenerActive) {
    track._iterListenerActive = true;
    track.addEventListener('animationiteration', _onIteration);
  }
}

function _onIteration() {
  const track = document.getElementById('news-ticker-track');
  if (!_pendingItems) {
    track._iterListenerActive = false;
    track.removeEventListener('animationiteration', _onIteration);
    return;
  }
  _loopCountdown--;
  if (_loopCountdown <= 0) {
    track._iterListenerActive = false;
    track.removeEventListener('animationiteration', _onIteration);
    const items = _pendingItems;
    _pendingItems = null;
    renderNewsTicker(items);
  }
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
  // .ticker-set은 display:inline → offsetWidth 신뢰 불가, track.scrollWidth 사용
  track.style.animation = 'none';
  track.innerHTML = `<span class="ticker-set">${html}</span>`;
  void track.offsetWidth;  // reflow 강제

  const setWidth = track.scrollWidth;  // inline-block 컨테이너 기준으로 측정

  // 2단계: 세트 2개로 복제 + 측정한 픽셀값을 CSS 변수로 전달 → 정확한 루프
  track.innerHTML = `<span class="ticker-set">${html}</span>` +
                    `<span class="ticker-set" aria-hidden="true">${html}</span>`;
  track.style.setProperty('--set-width', `${setWidth}px`);

  // 고정 속도 40px/s — animation 단축속성 전체를 인라인으로 세팅해
  // CSS 파일의 60s 기본값이 덮어씌우는 문제 방지
  const SPEED_PX_PER_SEC = 50;
  const duration = Math.max(TICKER_MIN_DURATION, setWidth / SPEED_PX_PER_SEC);
  void track.offsetWidth;  // reflow → 애니메이션 재시작 트리거
  track.style.animation = `ticker-scroll ${duration}s linear infinite`;

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
  if (!track) return;
  // 스크롤 애니메이션 중단 → 로딩 텍스트가 제자리에서 깜빡이도록
  track.style.animation = 'none';
  track.style.animationDuration = '';
  track.innerHTML =
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
