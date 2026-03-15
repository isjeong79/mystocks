/**
 * 가격 데이터 → DOM 렌더링
 * 의존: state.js, utils.js
 * openModal, sendWS는 main.js에서 init()으로 주입
 */

import { fmtKRW, fmtUSD, fmtFX, fmtChange, flashIfChanged, setClass, escHtml } from './utils.js';
import { appState } from './state.js';

let _openModal;
let _sendWS;

export function init({ openModal, sendWS }) {
  _openModal = openModal;
  _sendWS    = sendWS;
}

// ── 워치리스트 ────────────────────────────────────────────────────────────
export function renderWatchlist(watchlist) {
  appState.watchlistItems = watchlist || [];
  const grid = document.getElementById('stockGrid');
  grid.innerHTML = '';
  appState.watchlistItems.forEach(item => grid.appendChild(createCard(item)));

  // 추가 카드
  const add = document.createElement('div');
  add.className = 'stock-card add-card';
  add.onclick = _openModal;
  add.innerHTML = `<div class="add-icon">＋</div><div class="add-label">종목 추가</div>`;
  grid.appendChild(add);
}

export function createCard(item) {
  const isKRW = item.type === 'domestic';
  const dir   = item.dir ?? (item.change == null ? 'flat' : item.change > 0 ? 'up' : item.change < 0 ? 'down' : 'flat');
  const div   = document.createElement('div');

  div.className    = 'stock-card card-entering';
  div.id           = isKRW ? `card-d-${item.code}` : `card-f-${item.symbol}`;
  div.dataset.type = item.type;
  div.dataset.id   = isKRW ? item.code : item.symbol;

  div.innerHTML = `
    <button class="remove-btn" title="삭제">✕</button>
    <div class="stock-name">${escHtml(item.name)}</div>
    <div class="stock-price ${dir}">${item.price == null ? '-' : isKRW ? fmtKRW(item.price) : fmtUSD(item.price)}</div>
    <div class="stock-change ${dir}">${fmtChange(item.change, item.changeRate, dir, isKRW)}</div>
  `;
  div.querySelector('.remove-btn').onclick = e => {
    e.stopPropagation();
    div.classList.remove('card-entering');
    div.classList.add('card-leaving');
    setTimeout(() => {
      _sendWS(isKRW
        ? { type: 'remove_stock', stockType: 'domestic', code: item.code }
        : { type: 'remove_stock', stockType: 'foreign',  symbol: item.symbol });
    }, 180);
  };
  return div;
}

// ── 국내 종목 ─────────────────────────────────────────────────────────────
export function updateStockCard({ code, price, change, changeRate, dir }) {
  const card = document.querySelector(`[data-type="domestic"][data-id="${code}"]`);
  if (!card) return;
  const priceEl  = card.querySelector('.stock-price');
  const changeEl = card.querySelector('.stock-change');
  priceEl.textContent  = fmtKRW(price);
  changeEl.textContent = fmtChange(change, changeRate, dir, true);
  setClass(priceEl, dir); setClass(changeEl, dir);
  flashIfChanged(card, dir, `d-${code}`, price);
}

// ── 해외 종목 ─────────────────────────────────────────────────────────────
export function updateEtfCard({ symbol, price, change, changeRate, dir }) {
  const card = document.querySelector(`[data-type="foreign"][data-id="${symbol}"]`);
  if (!card) return;
  const priceEl  = card.querySelector('.stock-price');
  const changeEl = card.querySelector('.stock-change');
  priceEl.textContent  = fmtUSD(price);
  changeEl.textContent = fmtChange(change, changeRate, dir, false);
  setClass(priceEl, dir); setClass(changeEl, dir);
  flashIfChanged(card, dir, `f-${symbol}`, price);
}

// ── 원자재 ────────────────────────────────────────────────────────────────
export function updateCommodity({ symbol, price, change, changeRate, dir }) {
  const s        = symbol === 'WTI' ? 'wti' : 'brent';
  const priceEl  = document.getElementById(`${s}-price`);
  const changeEl = document.getElementById(`${s}-change`);
  const card     = document.getElementById(`card-${symbol}`);
  if (!priceEl) return;
  priceEl.textContent  = fmtUSD(price);
  changeEl.textContent = fmtChange(change, changeRate, dir, false);
  setClass(priceEl, dir); setClass(changeEl, dir);
  if (card) flashIfChanged(card, dir, `commodity-${symbol}`, price);
}

// ── 환율 ──────────────────────────────────────────────────────────────────
export function updateForex({ rate, change, changeRate, dir }) {
  const priceEl  = document.getElementById('fx-price');
  const changeEl = document.getElementById('fx-change');
  const card     = document.getElementById('card-USDKRW');
  priceEl.textContent  = fmtFX(rate);
  changeEl.textContent = fmtChange(change, changeRate, dir, true);
  setClass(priceEl, dir); setClass(changeEl, dir);
  flashIfChanged(card, dir, 'forex-USDKRW', rate);
}

// ── 국내 지수 (KOSPI / KOSDAQ) ────────────────────────────────────────────
export function updateIndex({ key, price, change, changeRate, dir }) {
  const k        = key.toLowerCase();
  const priceEl  = document.getElementById(`${k}-price`);
  const changeEl = document.getElementById(`${k}-change`);
  const card     = document.getElementById(`card-${key}`);
  if (!priceEl) return;
  priceEl.textContent  = price == null ? '-' : price.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  changeEl.textContent = fmtChange(change, changeRate, dir, false);
  setClass(priceEl, dir); setClass(changeEl, dir);
  flashIfChanged(card, dir, `index-${key}`, price);
}

// ── 야간선물 ──────────────────────────────────────────────────────────────
export function updateFutures({ price, change, changeRate, dir }) {
  const priceEl  = document.getElementById('fut-price');
  const changeEl = document.getElementById('fut-change');
  const card     = document.getElementById('card-KOSPI_NIGHT');
  priceEl.textContent  = price == null ? '-' : price.toFixed(2);
  changeEl.textContent = fmtChange(change, changeRate, dir, false);
  setClass(priceEl, dir); setClass(changeEl, dir);
  flashIfChanged(card, dir, 'futures-KOSPI_NIGHT', price);
}
