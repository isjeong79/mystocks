const axios = require('axios');
const { PUBLIC_DATA_KEY } = require('./config');
const { getKstNow } = require('./utils');

const _holidays       = new Set(); // 'YYYYMMDD'
let   _holidayLoadedYM = '';

async function _loadHolidaysForMonth(year, month) {
  if (!PUBLIC_DATA_KEY) return;
  try {
    const res = await axios.get(
      'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo',
      {
        params: {
          serviceKey: PUBLIC_DATA_KEY,
          solYear:    year,
          solMonth:   String(month).padStart(2, '0'),
          _type:      'json',
          numOfRows:  50,
        },
        timeout: 8000,
      }
    );
    const items = res.data?.response?.body?.items?.item;
    if (!items) return;
    const list = Array.isArray(items) ? items : [items];
    let count = 0;
    list.forEach(item => {
      if (item.isHoliday === 'Y') { _holidays.add(String(item.locdate)); count++; }
    });
    if (count) console.log(`[공휴일] ${year}년 ${month}월 ${count}건 로드`);
  } catch (e) {
    console.error('[공휴일] 조회 실패:', e.message);
  }
}

async function refreshHolidays() {
  const kst  = getKstNow();
  const yyyy = kst.getFullYear(), mm = kst.getMonth() + 1;
  const ym   = `${yyyy}${String(mm).padStart(2, '0')}`;
  if (_holidayLoadedYM === ym) return;
  _holidayLoadedYM = ym;
  await _loadHolidaysForMonth(yyyy, mm);
  const nm = mm === 12 ? 1  : mm + 1;
  const ny = mm === 12 ? yyyy + 1 : yyyy;
  await _loadHolidaysForMonth(ny, nm);
}

function _isKstHoliday(kstDate) {
  const yyyy = kstDate.getFullYear();
  const mm   = String(kstDate.getMonth() + 1).padStart(2, '0');
  const dd   = String(kstDate.getDate()).padStart(2, '0');
  return _holidays.has(`${yyyy}${mm}${dd}`);
}

function isNightFuturesOpen() {
  const kst = getKstNow();
  const hm  = kst.getHours() * 60 + kst.getMinutes();

  if (hm >= 5 * 60 && hm < 18 * 60) return false;

  const startDay = new Date(kst);
  if (hm < 5 * 60) startDay.setDate(startDay.getDate() - 1);

  const dow = startDay.getDay();
  if (dow === 0 || dow === 6) return false;

  if (_isKstHoliday(startDay)) return false;

  const t1 = new Date(startDay); t1.setDate(t1.getDate() + 1);
  if (_isKstHoliday(t1)) {
    const t2  = new Date(startDay); t2.setDate(t2.getDate() + 2);
    const t2d = t2.getDay();
    if (_isKstHoliday(t2) || t2d === 0 || t2d === 6) return false;
  }

  return true;
}

module.exports = { refreshHolidays, isNightFuturesOpen };
