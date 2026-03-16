'use strict';
const axios    = require('axios');
const { PUBLIC_DATA_KEY } = require('./config');
const { getKstNow } = require('./utils');

const _kr = new Set(); // 'YYYYMMDD' (KST 한국 공휴일)
const _us = new Set(); // 'YYYYMMDD' (ET  미국 휴장일)

let _krYear = 0;
let _usYear = 0;

// ── DB 모델 (지연 로드 – DB 연결 후 호출) ─────────────────────────────────────
let _HolidayModel = null;
function _model() {
  if (!_HolidayModel) _HolidayModel = require('./db/models/Holiday');
  return _HolidayModel;
}

// ── 한국 공휴일 ───────────────────────────────────────────────────────────────
async function _loadKr(year) {
  try {
    const cached = await _model().findOne({ country: 'KR', year }).lean();
    if (cached?.dates?.length) {
      cached.dates.forEach(d => _kr.add(d));
      console.log(`[공휴일] KR ${year}년 DB ${cached.dates.length}건`);
      return;
    }
    if (!PUBLIC_DATA_KEY) return;

    const dates = [];
    const months = Array.from({ length: 12 }, (_, i) => i + 1);
    await Promise.allSettled(months.map(async month => {
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
        (Array.isArray(items) ? items : [items])
          .filter(it => it.isHoliday === 'Y')
          .forEach(it => dates.push(String(it.locdate)));
      } catch {}
    }));

    if (dates.length) {
      dates.forEach(d => _kr.add(d));
      await _model().findOneAndUpdate(
        { country: 'KR', year },
        { dates, loadedAt: new Date() },
        { upsert: true, returnDocument: 'after' }
      );
      console.log(`[공휴일] KR ${year}년 API ${dates.length}건 저장`);
    }
  } catch (e) {
    console.error(`[공휴일] KR ${year}년 로드 실패:`, e.message);
  }
}

// ── 미국 휴장일 (Finnhub) ─────────────────────────────────────────────────────
async function _loadUs(year) {
  try {
    const cached = await _model().findOne({ country: 'US', year }).lean();
    if (cached?.dates?.length) {
      cached.dates.forEach(d => _us.add(d));
      console.log(`[공휴일] US ${year}년 DB ${cached.dates.length}건`);
      return;
    }

    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      console.warn('[공휴일] FINNHUB_API_KEY 미설정 – US 휴장일 체크 건너뜀');
      return;
    }

    const res = await axios.get('https://finnhub.io/api/v1/stock/market-holiday', {
      params:  { exchange: 'US', token: apiKey },
      timeout: 8000,
    });

    const dates = (res.data?.data ?? [])
      .filter(it => !it.tradingHour)                       // 전일 휴장만
      .filter(it => new Date(it.atDate).getFullYear() === year)
      .map(it => it.atDate.replace(/-/g, ''));             // 'YYYY-MM-DD' → 'YYYYMMDD'

    if (dates.length) {
      dates.forEach(d => _us.add(d));
      await _model().findOneAndUpdate(
        { country: 'US', year },
        { dates, loadedAt: new Date() },
        { upsert: true, returnDocument: 'after' }
      );
      console.log(`[공휴일] US ${year}년 Finnhub ${dates.length}건 저장`);
    }
  } catch (e) {
    console.error(`[공휴일] US ${year}년 로드 실패:`, e.message);
  }
}

// ── 외부 API ─────────────────────────────────────────────────────────────────
async function refreshHolidays() {
  const year = getKstNow().getFullYear();
  const next = year + 1;
  if (_krYear !== year) { _krYear = year; await _loadKr(year); await _loadKr(next); }
  if (_usYear !== year) { _usYear = year; await _loadUs(year); await _loadUs(next); }
}

// ── 조회 함수 ─────────────────────────────────────────────────────────────────
function isKstHoliday(kstDate) {
  const y = kstDate.getFullYear();
  const m = String(kstDate.getMonth() + 1).padStart(2, '0');
  const d = String(kstDate.getDate()).padStart(2, '0');
  return _kr.has(`${y}${m}${d}`);
}

/** 현재 America/New_York 날짜 기준으로 미국 휴장일 여부 반환 */
function isUsHoliday() {
  const nyDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return _us.has(nyDateStr.replace(/-/g, ''));
}

// ── 야간선물 ──────────────────────────────────────────────────────────────────
function isNightFuturesOpen() {
  const kst = getKstNow();
  const hm  = kst.getHours() * 60 + kst.getMinutes();
  if (hm >= 5 * 60 && hm < 18 * 60) return false;

  const startDay = new Date(kst);
  if (hm < 5 * 60) startDay.setDate(startDay.getDate() - 1);

  const dow = startDay.getDay();
  if (dow === 0 || dow === 6) return false;
  if (isKstHoliday(startDay)) return false;

  const t1 = new Date(startDay); t1.setDate(t1.getDate() + 1);
  if (isKstHoliday(t1)) {
    const t2  = new Date(startDay); t2.setDate(t2.getDate() + 2);
    const t2d = t2.getDay();
    if (isKstHoliday(t2) || t2d === 0 || t2d === 6) return false;
  }
  return true;
}

module.exports = { refreshHolidays, isKstHoliday, isUsHoliday, isNightFuturesOpen };
