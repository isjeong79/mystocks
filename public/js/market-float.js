/**
 * 시장 상태 플로팅 바
 * 의존 없음 — DOM만 조작
 */

export function init() {}

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
