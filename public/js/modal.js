/**
 * 종목 검색/추가 모달
 * 의존: state.js, utils.js
 * sendWS는 main.js에서 init()으로 주입
 */

import { appState } from './state.js';
import { escHtml, escAttr } from './utils.js';

let _sendWS;
let currentTab  = 'domestic';
let searchTimer = null;

export function init({ sendWS }) {
  _sendWS = sendWS;

  // 탭 버튼
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  // 검색 입력
  document.getElementById('search-input').addEventListener('input', onSearchInput);

  // 닫기 버튼
  document.getElementById('modal-close').addEventListener('click', closeModal);

  // 오버레이 클릭
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // ESC
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // 모바일 키보드 대응
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _adjustForKeyboard);
    window.visualViewport.addEventListener('scroll', _adjustForKeyboard);
  }
}

export function openModal() {
  currentTab = 'domestic';
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'domestic'));
  const input = document.getElementById('search-input');
  input.placeholder = '종목명 또는 종목코드 검색';
  input.value = '';
  document.getElementById('search-results').innerHTML = '<div class="search-hint">종목명이나 코드를 입력하세요</div>';
  document.getElementById('modal-overlay').classList.add('open');
  input.focus();
}

export function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('search-input').blur();
  overlay.classList.add('closing');
  overlay.classList.remove('open');
  const delay = window.innerWidth <= 500 ? 280 : 180;
  setTimeout(() => {
    overlay.classList.remove('closing');
    const m = document.getElementById('modal');
    m.style.marginBottom = '';
    m.style.maxHeight = '';
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').innerHTML = '<div class="search-hint">종목명이나 코드를 입력하세요</div>';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, delay);
}

function setTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const input = document.getElementById('search-input');
  input.placeholder = tab === 'domestic' ? '종목명 또는 종목코드 검색' : '티커 또는 회사명 검색';
  input.value = '';
  document.getElementById('search-results').innerHTML = '<div class="search-hint">종목명이나 코드를 입력하세요</div>';
  requestAnimationFrame(() => { input.focus(); _adjustForKeyboard(); });
}

function onSearchInput() {
  clearTimeout(searchTimer);
  const q = document.getElementById('search-input').value.trim();
  if (!q) {
    document.getElementById('search-results').innerHTML = '<div class="search-hint">종목명이나 코드를 입력하세요</div>';
    return;
  }
  document.getElementById('search-results').innerHTML = '<div class="search-hint">검색 중...</div>';
  searchTimer = setTimeout(() => _doSearch(q), 200);
}

async function _doSearch(q) {
  try {
    const res     = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${currentTab}`);
    const results = await res.json();
    _renderResults(results);
    _adjustForKeyboard();
  } catch {
    document.getElementById('search-results').innerHTML = '<div class="search-hint">검색에 실패했습니다</div>';
  }
}

function _renderResults(results) {
  const el = document.getElementById('search-results');
  if (!results.length) { el.innerHTML = '<div class="search-hint">검색 결과가 없습니다</div>'; return; }

  el.innerHTML = results.map((r, i) => {
    const isDomestic = currentTab === 'domestic';
    const id     = isDomestic ? r.code   : r.symbol;
    const type   = isDomestic ? 'domestic' : 'foreign';
    const exists = appState.watchlistItems.some(item =>
      isDomestic
        ? item.type === 'domestic' && item.code   === id
        : item.type === 'foreign'  && item.symbol === id
    );
    const name = escHtml(r.name || r.symbol);
    const sub  = isDomestic
      ? `<span class="result-code">${r.code}</span>`
      : `<span class="result-code">${r.symbol}</span> · ${r.typeDisp || ''}`;
    const delay = `${i * 40}ms`;
    return `
      <div class="search-result result-item-anim${exists ? ' exists' : ''}" style="animation-delay:${delay}"
           data-id="${escAttr(id)}" data-type="${type}"
           data-name="${escAttr(r.name || r.symbol)}"
           data-exchange="${escAttr(r.exchange || '')}">
        <div class="result-left">
          <span class="result-name">${name}</span>
          <span class="result-meta">${sub}</span>
        </div>
        <div class="result-right">
          <span class="result-exchange">${r.exchange || ''}</span>
          ${exists
            ? '<span class="result-added">추가됨</span>'
            : `<button class="result-add-btn" title="추가">+</button>`}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.search-result:not(.exists) .result-add-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const row      = btn.closest('.search-result');
      const type     = row.dataset.type;
      const id       = row.dataset.id;
      const name     = row.dataset.name;
      const exchange = row.dataset.exchange;
      _sendWS(type === 'domestic'
        ? { type: 'add_stock', stockType: 'domestic', code: id,   name }
        : { type: 'add_stock', stockType: 'foreign',  symbol: id, name, exchange });
      closeModal();
    });
  });
}

function _adjustForKeyboard() {
  if (!window.visualViewport) return;
  const overlay = document.getElementById('modal-overlay');
  if (!overlay.classList.contains('open')) return;
  const vv        = window.visualViewport;
  const keyboardH = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  const modal     = document.getElementById('modal');
  if (keyboardH > 10) {
    modal.style.maxHeight = Math.floor(vv.height * 0.92) + 'px';
    modal.style.marginBottom = (window.innerWidth <= 500) ? keyboardH + 'px' : '';
  } else {
    modal.style.maxHeight = '';
    modal.style.marginBottom = '';
  }
}
