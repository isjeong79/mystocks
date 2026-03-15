/**
 * MongoDB 기반 사용자별 워치리스트 관리
 *
 * - getWatchlistItems()       : KIS WS 구독용 전체 종목 (모든 사용자의 합집합)
 * - getWatchlistForUser(uid)  : 특정 사용자 종목 목록
 * - addItem / removeItem      : 사용자 종목 추가/삭제
 * - buildWithPrices(items)    : state 가격 정보 병합
 */

const WatchlistModel = require('./db/models/Watchlist');
const { DEFAULT_MARKET } = require('./kis/session');
const state = require('./state');

// ── 전역 합집합 (KIS WS 구독 관리용) ─────────────────────────────────────────
let _globalItems = [];

function getWatchlistItems() { return _globalItems; }

function _addToGlobal(item) {
  const key = _itemKey(item);
  if (!_globalItems.some(i => _itemKey(i) === key)) {
    _globalItems.push(item);
    _initStateForItem(item);
  }
}

function _itemKey(item) {
  return item.type === 'domestic' ? `d:${item.code}` : `f:${item.symbol}`;
}

function _initStateForItem(item) {
  if (item.type === 'domestic' && !state.stocks[item.code]) {
    state.stocks[item.code] = { name: item.name, code: item.code, price: null, change: null, changeRate: null, sign: '3', dir: 'flat' };
  } else if (item.type === 'foreign' && !state.usEtfs[item.symbol]) {
    state.usEtfs[item.symbol] = { name: item.name, symbol: item.symbol, price: null, change: null, changeRate: null, dir: 'flat' };
  }
}

// ── 서버 시작 시 모든 워치리스트 로드 ─────────────────────────────────────────
async function loadAllWatchlists() {
  const watchlists = await WatchlistModel.find({}).lean();
  _globalItems = [];
  for (const wl of watchlists) {
    for (const item of wl.items) _addToGlobal(item);
  }
  console.log(`[Watchlist] 전체 ${_globalItems.length}개 종목 로드 (${watchlists.length}명)`);
}

// ── 사용자별 워치리스트 ───────────────────────────────────────────────────────
async function getWatchlistForUser(userId) {
  if (!userId) return DEFAULT_ITEMS;
  try {
    const wl = await WatchlistModel.findOne({ userId }).lean();
    return wl ? wl.items : [];
  } catch { return []; }
}

async function addItemToUserWatchlist(userId, item) {
  if (!userId) return;
  // $push 원자 연산으로 race condition 방지 (중복 없을 때만 추가)
  const notExists = item.type === 'domestic'
    ? { items: { $not: { $elemMatch: { type: 'domestic', code: item.code } } } }
    : { items: { $not: { $elemMatch: { type: 'foreign', symbol: item.symbol } } } };
  await WatchlistModel.findOneAndUpdate(
    { userId, ...notExists },
    { $push: { items: item } },
    { upsert: true, new: true },
  ).catch(() => null); // 이미 존재 시 upsert 충돌 → 정상, 무시
  _addToGlobal(item);
  return getWatchlistForUser(userId);
}

async function removeItemFromUserWatchlist(userId, { stockType, code, symbol }) {
  if (!userId) return;
  // $pull 원자 연산으로 race condition 방지
  const pull = stockType === 'domestic'
    ? { items: { type: 'domestic', code } }
    : { items: { type: 'foreign', symbol } };
  const wl = await WatchlistModel.findOneAndUpdate(
    { userId }, { $pull: pull }, { new: true }
  );
  return wl ? wl.items : [];
}

// ── 가격 정보 병합 ────────────────────────────────────────────────────────────
function buildWithPrices(items) {
  return items.map(item => {
    if (item.type === 'domestic') {
      return { type: 'domestic', code: item.code, name: item.name, ...(state.stocks[item.code] ?? {}) };
    } else {
      return { type: 'foreign', symbol: item.symbol, name: item.name, ...(state.usEtfs[item.symbol] ?? {}) };
    }
  });
}

// ── 기본 종목 (비로그인) ──────────────────────────────────────────────────────
const DEFAULT_ITEMS = [
  { type: 'domestic', code: '005930', name: '삼성전자' },
  { type: 'domestic', code: '000660', name: 'SK하이닉스' },
  { type: 'domestic', code: '005380', name: '현대차' },
  { type: 'foreign',  symbol: 'QQQ', name: '나스닥100(QQQ)', market: 'NAS' },
  { type: 'foreign',  symbol: 'SPY', name: 'S&P500(SPY)',    market: 'AMS' },
  { type: 'foreign',  symbol: 'DIA', name: '다우존스(DIA)',  market: 'AMS' },
];

// ── 하위 호환: 서버 시작 시 기본 종목도 state에 등록 ──────────────────────────
function initDefaultState() {
  for (const item of DEFAULT_ITEMS) _initStateForItem(item);
}

module.exports = {
  getWatchlistItems,
  loadAllWatchlists,
  getWatchlistForUser,
  addItemToUserWatchlist,
  removeItemFromUserWatchlist,
  buildWithPrices,
  initDefaultState,
  DEFAULT_ITEMS,
};
