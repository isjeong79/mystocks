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
// 시간대(KST)별 상태표:
//  ~08:00              closed          야간 휴장
//  08:00~08:30         pre             장전 시간외종가 (전일종가 거래)
//  08:30~09:00         opening_auction 장개시 동시호가 (시가 결정)
//  09:00~15:20         open            정규장
//  15:20~15:30         closing_auction 장마감 동시호가 (종가 결정)
//  15:30~15:40         closed_wait     시간외 대기 (종가 확정, 거래 정지)
//  15:40~16:00         post            장마감후 시간외종가
//  16:00~18:00         after           시간외 단일가 (10분 단위 체결)
//  18:00~              closed          야간 휴장
function getDomesticStatus() {
  const kst     = getKstNow();
  const dow     = kst.getDay();
  const holiday = isKstHoliday(kst);

  if (dow === 0 || dow === 6 || holiday) return { status: 'closed', label: '휴장', color: 'flat' };

  const hm = kst.getHours() * 60 + kst.getMinutes();
  if (hm <  8*60)                        return { status: 'closed',          label: '휴장',        color: 'flat'   };
  if (hm <  8*60+30)                     return { status: 'pre',             label: '장전시간외',   color: 'accent' };
  if (hm <  9*60)                        return { status: 'opening_auction', label: '동시호가',     color: 'warn'   };
  if (hm < 15*60+20)                     return { status: 'open',            label: '정규장',       color: 'up'     };
  if (hm < 15*60+30)                     return { status: 'closing_auction', label: '마감동시호가', color: 'warn'   };
  if (hm < 15*60+40)                     return { status: 'closed_wait',     label: '시간외대기',   color: 'flat'   };
  if (hm < 16*60)                        return { status: 'post',            label: '시간외종가',   color: 'accent' };
  if (hm < 18*60)                        return { status: 'after',           label: '시간외단일가', color: 'warn'   };
  return { status: 'closed', label: '휴장', color: 'flat' };
}

// ── 미국주식 시장 상태 ────────────────────────────────────────────────────────
function getUsStatus() {
  const kst = getKstNow();
  const dow = kst.getDay();
  const hm  = kst.getHours() * 60 + kst.getMinutes();
  const dst = isDstActive();

  const dayOpen    = 9*60;                       // 09:00 KST (KIS 주간거래 시작)
  const preOpen    = dst ? 17*60    : 18*60;    // 17:00 or 18:00 KST
  const regOpen    = dst ? 22*60+30 : 23*60+30; // 22:30 or 23:30 KST
  const regClose   = dst ? 5*60     : 6*60;     // 05:00 or 06:00 KST (다음날)
  const afterClose = 9*60;                       // 09:00 KST

  // 일요일: 항상 휴장
  if (dow === 0) return { status: 'closed', label: '휴장', color: 'flat' };

  // 토요일: 자정~regClose는 금요일 정규장 연속, 이후 애프터 or 휴장
  if (dow === 6) {
    if (hm < regClose) {
      if (isUsHoliday()) return { status: 'closed', label: '휴장', color: 'flat' };
      return { status: 'open',  label: '정규장', color: 'up'   };
    }
    if (hm < afterClose) {
      if (isUsHoliday()) return { status: 'closed', label: '휴장', color: 'flat' };
      return { status: 'after', label: '애프터', color: 'warn' };
    }
    return { status: 'closed', label: '휴장', color: 'flat' };
  }

  // 월요일 자정~preOpen: 일요일 장 없으므로 주간거래 전까지 휴장, 이후 주간거래
  if (dow === 1) {
    if (hm < dayOpen) return { status: 'closed', label: '휴장',   color: 'flat'   };
    if (hm < preOpen) return { status: 'day',    label: '주간거래', color: 'accent' };
  }

  // 금요일 오후 09:00~preOpen: 주말 전 휴장 구간
  if (dow === 5 && hm >= afterClose && hm < preOpen) return { status: 'closed', label: '휴장', color: 'flat' };

  // 미국 공휴일 체크 (평일 거래 구간)
  if (isUsHoliday()) return { status: 'closed', label: '휴장', color: 'flat' };

  // 평일 일반 로직
  if (hm >= regOpen || hm < regClose)    return { status: 'open',  label: '정규장',   color: 'up'   };
  if (hm >= regClose && hm < afterClose) return { status: 'after', label: '애프터',   color: 'warn' };
  if (hm >= preOpen)                     return { status: 'pre',   label: '프리마켓', color: 'warn' };
  if (hm >= dayOpen && hm < preOpen)     return { status: 'day',   label: '주간거래', color: 'accent' };
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

// 국내 시세 API 호출이 의미 있는 구간 여부 (closed / closed_wait 제외)
function isDomesticOpen() {
  const s = getDomesticStatus().status;
  return s !== 'closed' && s !== 'closed_wait';
}

// 시간외 단일가 구간 여부 (10분 폴링 전용)
function isDomesticAfterHours() {
  return getDomesticStatus().status === 'after';
}

module.exports = { getAllMarketStatus, getDomesticStatus, isDomesticOpen, isDomesticAfterHours };
