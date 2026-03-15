/**
 * 포맷터, DOM 헬퍼, 이스케이프 유틸
 * 외부 의존성 없음 — 어디서나 import 가능
 */

// ── 방향 ─────────────────────────────────────────────────────────────────
export const calcDir = c => c > 0 ? 'up' : c < 0 ? 'down' : 'flat';

// ── 가격 포맷 ─────────────────────────────────────────────────────────────
export const fmtKRW = n =>
  n == null ? '-' : n.toLocaleString('ko-KR') + '원';

export const fmtUSD = n =>
  n == null ? '-' : '$' + n.toFixed(2);

export const fmtFX = n =>
  n == null ? '-' : n.toLocaleString('ko-KR', { minimumFractionDigits: 2 }) + '원';

export function fmtChange(c, r, dir, isKRW = true) {
  if (c == null) return '-';
  const sign = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  const val  = isKRW ? Math.abs(c).toLocaleString('ko-KR') : Math.abs(c).toFixed(2);
  return `${sign} ${val} (${Math.abs(r ?? 0).toFixed(2)}%)`;
}

// ── 이스케이프 ────────────────────────────────────────────────────────────
export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── DOM 헬퍼 ──────────────────────────────────────────────────────────────
export function flashEl(el, dir) {
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // reflow 강제
  if (dir === 'up')   el.classList.add('flash-up');
  if (dir === 'down') el.classList.add('flash-down');
}

export function setClass(el, dir) {
  el.className = el.className.replace(/\b(up|down|flat)\b/g, '').trim();
  el.classList.add(dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'flat');
}

// 값이 바뀐 경우에만 플래시 (불필요한 애니메이션 방지)
const _prev = {};
export function flashIfChanged(el, dir, key, newVal) {
  if (_prev[key] === newVal) return;
  _prev[key] = newVal;
  flashEl(el, dir);
}
