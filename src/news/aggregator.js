/**
 * 3-Track 뉴스 통합 모듈
 *
 * Track 1 – 해외 거시/주도주  : Finnhub → 키워드 필터 → Gemini 번역
 * Track 2 – 국내 거시          : Google News RSS (한국어)
 * Track 3 – 국내 공시/시황     : 연합뉴스 경제 RSS
 *
 * 모든 Track은 Promise.allSettled로 병렬 실행 → 장애 격리
 * 수집 후 신규 항목만 MongoDB insert, 서버 메모리에 캐시하지 않음(Stateless)
 */

'use strict';

const axios     = require('axios');
const RSSParser = require('rss-parser');
const News      = require('../db/models/News');

// ── 상수 ─────────────────────────────────────────────────────────────────────

const FINNHUB_BASE   = 'https://finnhub.io/api/v1';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL   = 'gemini-2.0-flash';   // 2026년 기준 무료 최신 모델
// 한글 쿼리를 encodeURIComponent로 인코딩 (unescaped characters 에러 방지)
const GOOGLE_NEWS_RSS =
  'https://news.google.com/rss/search?q=' +
  encodeURIComponent('코스피 OR 한국은행 OR 금융위 OR 기준금리 OR 코스닥') +
  '&hl=ko&gl=KR&ceid=KR:ko';
// Track 3: 연합뉴스 경제 RSS (KIS 뉴스 API 미지원으로 대체)
const YONHAP_ECONOMY_RSS = 'https://www.yna.co.kr/rss/economy.xml';
const RSS_TIMEOUT    = 10_000;   // ms
const GEMINI_TIMEOUT = 20_000;
const MAX_NEWS_AGE_MS = 4 * 60 * 60 * 1000; // 4시간 이내 뉴스만 처리

/**
 * Finnhub 키워드 필터
 * 미국 시총 상위 20대 기술주, 주요 거시경제 지표, 지정학적 리스크 등 30개+
 */
const GLOBAL_KEYWORDS = [
  // 연준 / 금리
  'Fed', 'Federal Reserve', 'FOMC', 'Powell', 'rate cut', 'rate hike',
  'interest rate', 'CPI', 'inflation', 'GDP', 'recession', 'yield',
  // 지정학
  'War', 'Ukraine', 'Russia', 'Israel', 'Gaza', 'Taiwan', 'sanctions', 'tariff',
  // 미국 시총 상위 기술주
  'Apple', 'Microsoft', 'Nvidia', 'Amazon', 'Alphabet', 'Google', 'Meta',
  'Tesla', 'Broadcom', 'TSMC', 'AMD', 'Netflix', 'Eli Lilly',
  'Berkshire', 'JPMorgan', 'Visa', 'Mastercard', 'UnitedHealth', 'Exxon',
  // 시장 지표
  'S&P 500', 'Nasdaq', 'Dow Jones', 'VIX', 'Treasury', 'dollar', 'DXY',
  // 기업 이벤트
  'earnings', 'IPO', 'M&A', 'layoffs', 'bankruptcy', 'merger',
];

const KEYWORD_RE = new RegExp(GLOBAL_KEYWORDS.join('|'), 'i');

const rssParser = new RSSParser({ timeout: RSS_TIMEOUT });

// ── Track 1: Finnhub 해외 뉴스 ───────────────────────────────────────────────

async function fetchGlobalNews() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error('FINNHUB_API_KEY 미설정');

  const res = await axios.get(`${FINNHUB_BASE}/news`, {
    params: { category: 'general', token: apiKey },
    timeout: 10_000,
  });

  const cutoff = Date.now() - MAX_NEWS_AGE_MS;
  const filtered = (res.data ?? []).filter(item =>
    KEYWORD_RE.test(item.headline) &&
    item.datetime * 1000 >= cutoff
  );

  if (filtered.length === 0) return [];

  // 최신순 정렬 후 상위 5개만 슬라이싱
  const sliced = filtered
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, 5);

  // DB에 이미 저장된 newsId 확인 → 신규 항목만 Gemini 번역
  const candidateIds = sliced.map(item => `finnhub-${item.id}`);
  const existing = await News.find(
    { newsId: { $in: candidateIds } },
    { newsId: 1, title: 1, headline_original: 1 }
  ).lean();
  // headline_original과 title이 같으면 번역 실패로 저장된 것 → 재번역 대상에 포함
  const existingMap = new Map(
    existing
      .filter(n => n.headline_original && n.title !== n.headline_original)
      .map(n => [n.newsId, n.title])
  );

  const newItems = sliced.filter(item => !existingMap.has(`finnhub-${item.id}`));

  // 신규 항목만 Gemini 번역 (기존 항목은 DB 저장 title 재사용)
  const translated = newItems.length > 0
    ? await translateWithGemini(newItems)
    : [];

  return sliced.map(item => {
    const id = `finnhub-${item.id}`;
    if (existingMap.has(id)) {
      return {
        newsId:             id,
        title:              existingMap.get(id),
        headline_original:  item.headline,
        source:             item.source || 'Finnhub',
        url:                item.url || '',
        track:              'global',
        timestamp:          new Date(item.datetime * 1000),
      };
    }
    const t = translated.find(d => d.id === item.id) || item;
    return {
      newsId:             id,
      title:              t.headline_ko || item.headline,
      headline_original:  item.headline,
      source:             item.source || 'Finnhub',
      url:                item.url || '',
      track:              'global',
      timestamp:          new Date(item.datetime * 1000),
    };
  });
}

// ── Track 1 보조: Gemini 번역 (단 1회 API 호출로 배열 전체 번역) ───────────────

/**
 * Finnhub 뉴스 배열을 받아 headline 필드를 한국어로 번역 후 동일 구조로 반환
 * 1 RPM 소모 → 2분 수집 주기에서 429 완전 회피
 */
async function translateWithGemini(items) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[News] GEMINI_API_KEY 미설정 → 원문 사용');
    return items;
  }

  // headline 필드만 번역 요청 (원본 구조 그대로 반환)
  const prompt =
    '아래 JSON 배열에서 headline 값만 한국어로 번역한 뒤, ' +
    '원래와 똑같은 구조의 JSON 배열로 리턴해 줘. ' +
    '번역된 필드명은 headline_ko로 추가하고, 나머지 필드는 그대로 유지해. ' +
    '코드블록, 설명 없이 순수 JSON 배열만 응답.\n' +
    JSON.stringify(items.map(i => ({ id: i.id, headline: i.headline })));

  try {
    const res = await axios.post(
      `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: GEMINI_TIMEOUT },
    );
    const raw   = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    // greedy 매칭: 배열 전체를 정확히 캡처 (non-greedy *? 는 첫 ] 에서 잘림)
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn('[News] Gemini 응답 JSON 파싱 실패, 원문:\n', raw.slice(0, 200));
      return items;
    }

    const translated = JSON.parse(match[0]);
    if (!Array.isArray(translated)) return items;

    // id 기준으로 원본과 병합
    const map = new Map(translated.map(t => [String(t.id), t.headline_ko]));
    const result = items.map(item => ({
      ...item,
      headline_ko: map.get(String(item.id)) || item.headline,
    }));
    console.log(`[News] Gemini 번역 완료: ${result.filter(r => r.headline_ko !== r.headline).length}/${items.length}건`);
    return result;
  } catch (e) {
    console.warn('[News] Gemini 번역 실패, 원문 사용:', e.message);
    return items;
  }
}

// ── Track 2: Google News RSS 국내 거시 ───────────────────────────────────────

async function fetchDomesticNews() {
  const feed = await rssParser.parseURL(GOOGLE_NEWS_RSS);
  const cutoff = new Date(Date.now() - MAX_NEWS_AGE_MS);

  return (feed.items ?? [])
    .filter(item => new Date(item.pubDate) >= cutoff)
    .map(item => ({
      newsId:    `gnews-${Buffer.from(item.link || item.title).toString('base64').slice(0, 40)}`,
      title:     item.title?.replace(/\s*-\s*[^-]+$/, '').trim() || '',  // " - 출처명" 제거
      source:    extractRssSource(item.title) || '구글뉴스',
      url:       item.link || '',
      track:     'domestic',
      timestamp: new Date(item.pubDate || Date.now()),
    }))
    .filter(n => n.title.length > 5);
}

/** RSS 제목 끝의 " - 출처명" 패턴에서 출처 추출 */
function extractRssSource(title = '') {
  const m = title.match(/[-–]\s*([^-–]+?)\s*$/);
  return m ? m[1].trim() : '';
}

// ── Track 3: 연합뉴스 경제 RSS (공시/시황) ───────────────────────────────────

async function fetchDisclosureNews() {
  const feed = await rssParser.parseURL(YONHAP_ECONOMY_RSS);
  const cutoff = new Date(Date.now() - MAX_NEWS_AGE_MS);

  return (feed.items ?? [])
    .filter(item => new Date(item.pubDate) >= cutoff)
    .map(item => ({
      newsId:    `yna-${Buffer.from(item.link || item.title || '').toString('base64').slice(0, 40)}`,
      title:     (item.title || '').trim(),
      source:    '연합뉴스',
      url:       item.link || '',
      track:     'disclosure',
      timestamp: new Date(item.pubDate || Date.now()),
    }))
    .filter(n => n.title.length > 5);
}

// ── 병합 및 DB 저장 ───────────────────────────────────────────────────────────

/**
 * 3-Track 병렬 수집 → 신규 항목만 DB insert → 삽입된 항목 반환
 * 실패한 Track은 경고 로그만 남기고 무시 (장애 격리)
 */
async function aggregateAndSave() {
  const [r1, r2, r3] = await Promise.allSettled([
    fetchGlobalNews(),
    fetchDomesticNews(),
    fetchDisclosureNews(),
  ]);

  const logTrack = (name, result) => {
    if (result.status === 'rejected') {
      console.warn(`[News] Track ${name} 실패:`, result.reason?.message);
    } else {
      console.log(`[News] Track ${name}: ${result.value.length}건`);
    }
  };
  logTrack('1(Global)', r1);
  logTrack('2(Domestic)', r2);
  logTrack('3(Disclosure)', r3);

  // 성공한 Track만 합산
  const all = [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
  ];

  if (all.length === 0) return [];

  // 중복 제거 (newsId 기준 Map)
  const unique = [...new Map(all.map(n => [n.newsId, n])).values()];

  // insertMany with ordered:false → 중복 키 에러 무시, 나머지 삽입
  let inserted = [];
  try {
    const result = await News.insertMany(unique, { ordered: false, rawResult: true });
    // 삽입된 newsId 목록으로 실제 신규 항목 추출
    const insertedIds = new Set(
      (result.insertedIds ? Object.values(result.insertedIds).map(id => id.toString()) : [])
    );
    inserted = unique.filter((_, i) =>
      result.insertedIds && insertedIds.has(
        Object.values(result.insertedIds)[Object.keys(result.insertedIds).indexOf(String(i))]?.toString()
      )
    );
    // rawResult가 복잡할 경우 fallback: 전체 unique 반환 (중복은 위에서 이미 걸렀으므로 거의 다 신규)
    if (inserted.length === 0 && result.insertedCount > 0) inserted = unique;
    console.log(`[News] DB insert: ${result.insertedCount}건 신규`);
  } catch (e) {
    // BulkWriteError: 일부 duplicate key 에러 포함 가능 → 성공분만 사용
    if (e.name === 'MongoBulkWriteError' || e.code === 11000) {
      inserted = unique; // 화면 표시용으로 unique 전체 사용 (중복은 이미 DB에 있는 것)
      console.log(`[News] DB insert (일부 중복 포함): ${e.result?.nInserted ?? '?'}건 신규`);
    } else {
      console.error('[News] DB insert 실패:', e.message);
      return [];
    }
  }

  // timestamp 내림차순 정렬
  return unique
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 30); // 브로드캐스트는 최신 30건만
}

module.exports = { aggregateAndSave };
