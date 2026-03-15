const { getKstNow } = require('../utils');
const { isNightFuturesOpen, isKstHoliday, isUsHoliday } = require('../holidays');

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
  if (hm >= 7*60+30 && hm < 8*60+30)  return { status: 'pre',    label: '장전단일가', color: 'warn' };
  if (hm >= 8*60+30 && hm < 9*60)     return { status: 'pre',    label: '동시호가',  color: 'warn' };
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

  const preOpen    = dst ? 17*60    : 18*60;    // 17:00 or 18:00 KST
  const regOpen    = dst ? 22*60+30 : 23*60+30; // 22:30 or 23:30 KST
  const regClose   = dst ? 5*60     : 6*60;     // 05:00 or 06:00 KST (다음날)
  const afterClose = 9*60;                       // 09:00 KST

  // 현재 ET 현지 날짜 (공휴일 체크용)
  const etOffsetMs = dst ? -4 * 3600000 : -5 * 3600000;
  const etNow      = new Date(Date.now() + etOffsetMs);

  // 일요일: 항상 휴장
  if (dow === 0) return { status: 'closed', label: '휴장', color: 'flat' };

  // 토요일: 자정~regClose는 금요일 정규장 연속, 이후 애프터 or 휴장
  if (dow === 6) {
    if (hm < regClose) {
      if (isUsHoliday(etNow)) return { status: 'closed', label: '휴장', color: 'flat' };
      return { status: 'open',  label: '정규장', color: 'up'   };
    }
    if (hm < afterClose) {
      if (isUsHoliday(etNow)) return { status: 'closed', label: '휴장', color: 'flat' };
      return { status: 'after', label: '애프터', color: 'warn' };
    }
    return { status: 'closed', label: '휴장', color: 'flat' };
  }

  // 월요일 자정~preOpen: 일요일 장 없으므로 프리마켓 시작 전까지 전구간 휴장
  if (dow === 1 && hm < preOpen) return { status: 'closed', label: '휴장', color: 'flat' };

  // 금요일 오후 09:00~preOpen: 주말 전 휴장 구간
  if (dow === 5 && hm >= afterClose && hm < preOpen) return { status: 'closed', label: '휴장', color: 'flat' };

  // 미국 공휴일 체크 (평일 거래 구간)
  if (isUsHoliday(etNow)) return { status: 'closed', label: '휴장', color: 'flat' };

  // 평일 일반 로직
  if (hm >= regOpen || hm < regClose)    return { status: 'open',  label: '정규장',   color: 'up'   };
  if (hm >= regClose && hm < afterClose) return { status: 'after', label: '애프터',   color: 'warn' };
  if (hm >= preOpen)                     return { status: 'pre',   label: '프리마켓', color: 'warn' };
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
