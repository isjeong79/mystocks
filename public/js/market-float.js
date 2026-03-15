/**
 * 시장 상태 플로팅 바
 * 의존 없음 — DOM만 조작
 */

let _minimized = false;

export function init() {
  const el = document.getElementById('market-float');

  // 최소화 상태에서 전체 클릭 → 열기
  el.addEventListener('click', () => {
    if (_minimized) toggle();
  });

  // 최소화 버튼 (클릭 이벤트 버블링 차단)
  document.getElementById('mf-toggle').addEventListener('click', e => {
    e.stopPropagation();
    toggle();
  });
}

export function toggle() {
  _minimized = !_minimized;
  document.getElementById('market-float').classList.toggle('minimized', _minimized);
  document.getElementById('mf-toggle').textContent = _minimized ? '열기' : '최소화';
}

export function update({ domestic, us, futures }) {
  _applyStatus('mf-item-dom', 'mf-dom-dot', 'mf-dom-lbl', domestic);
  _applyStatus('mf-item-us',  'mf-us-dot',  'mf-us-lbl',  us);
  _applyStatus('mf-item-fut', 'mf-fut-dot', 'mf-fut-lbl', futures);
}

function _applyStatus(itemId, dotId, lblId, { label, color }) {
  const cls = 'mf-' + color;
  document.getElementById(itemId).className = `mf-item item-${color}`;
  document.getElementById(dotId).className  = `mf-dot ${cls}`;
  const lbl = document.getElementById(lblId);
  lbl.className   = `mf-status ${cls}`;
  lbl.textContent = label;
}
