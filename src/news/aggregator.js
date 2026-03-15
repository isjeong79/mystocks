/**
 * 3-Track 뉴스 통합 모듈
 *
 * Track 1 – 해외 거시/주도주  : Finnhub → 키워드 필터 → DeepL 번역
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
// 무료 플랜 키는 :fx 로 끝남 → api-free.deepl.com 사용
// 유료 플랜이라면 api.deepl.com 으로 변경
const DEEPL_BASE     = 'https://api-free.deepl.com/v2';
const DEEPL_TIMEOUT  = 15_000;
// 한글 쿼리를 encodeURIComponent로 인코딩 (unescaped characters 에러 방지)
const GOOGLE_NEWS_RSS =
  'https://news.google.com/rss/search?q=' +
  encodeURIComponent('코스피 OR 한국은행 OR 금융위 OR 기준금리 OR 코스닥') +
  '&hl=ko&gl=KR&ceid=KR:ko';
// Track 3: 연합뉴스 경제 RSS
const YONHAP_ECONOMY_RSS = 'https://www.yna.co.kr/rss/economy.xml';
const RSS_TIMEOUT    = 10_000;
const MAX_NEWS_AGE_MS = 4 * 60 * 60 * 1000; // 4시간 이내 뉴스만 처리

/**
 * Finnhub 키워드 필터
 * 미국 시총 상위 20대 기술주, 주요 거시경제 지표, 지정학적 리스크 등
 */
const GLOBAL_KEYWORDS = [
  // 연준 / 금리
  'Fed', 'Federal Reserve', 'FOMC', 'Powell', 'rate cut', 'rate hike',
  'interest rate', 'CPI', 'inflation', 'GDP', 'recession', 'yield',
  // 지정학
  'War', 'Ukraine', 'Russia', 'Israel', 'Gaza', 'Taiwan', 'Iran',
  'sanctions', 'tariff',
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

  // DB 조회: 번역 성공 항목만 캐시 재사용
  // (headline_original 없거나 title === headline_original 인 항목은 재번역)
  const candidateIds = sliced.map(item => `finnhub-${item.id}`);
  const existing = await News.find(
    { newsId: { $in: candidateIds } },
    { newsId: 1, title: 1, headline_original: 1 }
  ).lean();

  const existingMap = new Map(
    existing
      .filter(n => n.headline_original && n.title !== n.headline_original)
      .map(n => [n.newsId, n.title])
  );

  // 신규 + 번역 미완료 항목 → DeepL 번역
  const newItems = sliced.filter(item => !existingMap.has(`finnhub-${item.id}`));

  let translatedTitles = null;
  if (newItems.length > 0) {
    translatedTitles = await translateWithDeepL(newItems.map(i => i.headline));
  }

  return sliced.map(item => {
    const id = `finnhub-${item.id}`;

    // 번역 성공 캐시
    if (existingMap.has(id)) {
      return {
        newsId:            id,
        title:             existingMap.get(id),
        headline_original: item.headline,
        source:            item.source || 'Finnhub',
        url:               item.url || '',
        track:             'global',
        timestamp:         new Date(item.datetime * 1000),
      };
    }

    // 신규 or 재번역 항목: DeepL 결과 적용 (인덱스 순서 일치)
    const idx = newItems.findIndex(n => n.id === item.id);
    const title = (translatedTitles && idx >= 0 && translatedTitles[idx])
      ? translatedTitles[idx]
      : item.headline;

    return {
      newsId:            id,
      title,
      headline_original: item.headline,
      source:            item.source || 'Finnhub',
      url:               item.url || '',
      track:             'global',
      timestamp:         new Date(item.datetime * 1000),
    };
  });
}

// ── Track 1 보조: DeepL 번역 ──────────────────────────────────────────────────

/**
 * 헤드라인 문자열 배열을 DeepL로 한국어 번역 후 번역문 배열 반환
 * 실패 시 null 반환 → 호출부에서 원문 폴백 처리
 */
async function translateWithDeepL(headlines) {
  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) {
    console.warn('[News] DEEPL_API_KEY 미설정 → 원문 사용');
    return null;
  }

  try {
    const res = await axios.post(
      `${DEEPL_BASE}/translate`,
      { text: headlines, target_lang: 'KO' },
      {
        headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
        timeout: DEEPL_TIMEOUT,
      }
    );
    const translated = res.data?.translations?.map(t => t.text) ?? null;
    console.log(`[News] DeepL 번역 완료: ${translated?.length ?? 0}건`);
    return translated;
  } catch (e) {
    console.warn('[News] DeepL 번역 실패, 원문 사용:', e.response?.status, e.message);
    return null;
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

  // 번역 실패한 global 뉴스는 DB 저장 제외
  // → 다음 주기에 다시 신규로 인식되어 DeepL 재시도
  const toSave = unique.filter(n =>
    n.track !== 'global' ||
    !n.headline_original ||
    n.title !== n.headline_original
  );

  // insertMany with ordered:false → 중복 키 에러 무시, 나머지 삽입
  try {
    const result = await News.insertMany(toSave, { ordered: false });
    console.log(`[News] DB insert: ${result.length}건 신규`);
  } catch (e) {
    if (e.name === 'MongoBulkWriteError' || e.code === 11000) {
      console.log(`[News] DB insert (일부 중복 포함): ${e.result?.nInserted ?? '?'}건 신규`);
    } else {
      console.error('[News] DB insert 실패:', e.message);
      return [];
    }
  }

  // timestamp 내림차순 정렬, 최신 30건만 브로드캐스트
  return unique
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 30);
}

module.exports = { aggregateAndSave };
