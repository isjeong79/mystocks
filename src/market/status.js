const { getKstNow } = require('../utils');
const { isNightFuturesOpen, isKstHoliday } = require('../holidays');

// 서머타임 여부 (미국 DST)
function isDstActive() {
  const now = new Date();
  const y   = now.getUTCFullYear();
  const dstStart = (() => {
    let d = new Date(Date.UTC(y, 2, 1)), cnt = 0;
    while (cnt < 2) { if (d.getUTCDay() === 0) cnt++; if (cnt < 2) d.setUTCDate(d.getUTCDate() + 1); }
    return new Date(d.getTime() + 7 * 3600000);
  })();
  const dstEnd = (() => {
    let d = new Date(Date.UTC(y, 10, 1));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
    return new Date(d.getTime() + 6 * 3600000);
  })();
  return now >= dstStart && now < dstEnd;
}

// ── 국내주식 시장 상태 ────────────────────────────────────────────────────────
function getDomesticStatus() {
  const kst     = getKstNow();
  const dow     = kst.getDay();
  const holiday = isKstHoliday(kst);

  if (dow === 0 || dow === 6 || holiday) return { status: 'closed', label: '휴장',     color: 'flat' };

  const hm = kst.getHours() * 60 + kst.getMinutes();
  if (hm >= 8*60+30 && hm < 9*60)     return { status: 'pre',    label: '동시호가', color: 'warn' };
  if (hm >= 9*60    && hm < 15*60+30) return { status: 'open',   label: '정규장',   color: 'up'   };
  if (hm >= 15*60+30 && hm < 16*60)  return { status: 'after',  label: '시간외',   color: 'warn' };
  if (hm >= 16*60    && hm < 17*60)  return { status: 'single', label: '단일가',   color: 'warn' };
  if (hm >= 17*60)                   return { status: 'nxt',    label: 'NXT야간',  color: 'accent' };
  return { status: 'closed', label: '휴장', color: 'flat' };
}

// ── 미국주식 시장 상태 ────────────────────────────────────────────────────────
function getUsStatus() {
  const kst = getKstNow();
  const dow = kst.getDay();
  const hm  = kst.getHours() * 60 + kst.getMinutes();
  const dst = isDstActive();

  const preOpen    = dst ? 17*60    : 18*60;   // 17:00 or 18:00 KST
  const regOpen    = dst ? 22*60+30 : 23*60+30; // 22:30 or 23:30 KST
  const regClose   = dst ? 5*60     : 6*60;    // 05:00 or 06:00 KST (다음날)
  const afterClose = 9*60;                      // 09:00 KST

  // 토요일: 자정~장마감(05/06시)은 금요일 정규장 연속, 이후 주말 휴장
  if (dow === 6) {
    if (hm < regClose)   return { status: 'open',   label: '정규장', color: 'up'   };
    if (hm < afterClose) return { status: 'after',  label: '애프터', color: 'warn' };
    return { status: 'closed', label: '휴장', color: 'flat' };
  }

  // 일요일: 저녁 프리마켓 전까지 휴장
  if (dow === 0) {
    if (hm >= regOpen)  return { status: 'open', label: '정규장',   color: 'up'   };
    if (hm >= preOpen)  return { status: 'pre',  label: '프리마켓', color: 'warn' };
    return { status: 'closed', label: '휴장', color: 'flat' };
  }

  // 금요일 오후 09:00~preOpen: 주말 전 휴장 구간 (프리마켓 없음)
  if (dow === 5 && hm >= afterClose && hm < preOpen) {
    return { status: 'closed', label: '휴장', color: 'flat' };
  }

  // 평일 일반 로직
  if (hm >= regOpen || hm < regClose)        return { status: 'open',  label: '정규장',   color: 'up'   };
  if (hm >= regClose && hm < afterClose)     return { status: 'after', label: '애프터',   color: 'warn' };
  if (hm >= preOpen)                         return { status: 'pre',   label: '프리마켓', color: 'warn' };
  return { status: 'closed', label: '휴장', color: 'flat' };
}

// ── 전체 시장 상태 ────────────────────────────────────────────────────────────
function getAllMarketStatus() {
  const futOpen = isNightFuturesOpen();
  return {
    domestic: getDomesticStatus(),
    us:       getUsStatus(),
    futures:  futOpen
      ? { status: 'open',   label: '거래중', color: 'up'   }
      : { status: 'closed', label: '휴장',   color: 'flat' },
  };
}

// 국내 정규장 여부 (KOSPI/KOSDAQ 지수 주기적 갱신 판단용)
function isDomesticOpen() {
  const s = getDomesticStatus().status;
  return s !== 'closed';
}

module.exports = { getAllMarketStatus, isDomesticOpen };
