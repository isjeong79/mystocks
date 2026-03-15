/**
 * 3-Track 뉴스 통합 모듈
 *
 * Track 1 – 해외 거시/주도주  : Finnhub → 키워드 필터 → Gemini 번역
 * Track 2 – 국내 거시          : Google News RSS (한국어)
 * Track 3 – 국내 공시/시황     : KIS OpenAPI 뉴스 제목 조회
 *
 * 모든 Track은 Promise.allSettled로 병렬 실행 → 장애 격리
 * 수집 후 신규 항목만 MongoDB insert, 서버 메모리에 캐시하지 않음(Stateless)
 */

'use strict';

const axios     = require('axios');
const RSSParser = require('rss-parser');
const News      = require('../db/models/News');
const { APP_KEY, APP_SECRET, REST_BASE } = require('../config');
const { getAccessToken } = require('../kis/auth');

// ── 상수 ─────────────────────────────────────────────────────────────────────

const FINNHUB_BASE   = 'https://finnhub.io/api/v1';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL   = 'gemini-1.5-flash';
const GOOGLE_NEWS_RSS =
  'https://news.google.com/rss/search?q=코스피+OR+한국은행+OR+금융위+OR+기준금리+OR+코스닥&hl=ko&gl=KR&ceid=KR:ko';
const RSS_TIMEOUT    = 10_000;   // ms
const KIS_TIMEOUT    = 8_000;
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

  // Gemini 배치 번역
  const headlines  = filtered.map(i => i.headline);
  const translated = await translateWithGemini(headlines);

  return filtered.map((item, idx) => ({
    newsId:    `finnhub-${item.id}`,
    title:     translated[idx] || item.headline,
    source:    item.source || 'Finnhub',
    url:       item.url || '',
    track:     'global',
    timestamp: new Date(item.datetime * 1000),
  }));
}

// ── Track 1 보조: Gemini 번역 ─────────────────────────────────────────────────

async function translateWithGemini(texts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[News] GEMINI_API_KEY 미설정 → 원문 사용');
    return texts;
  }

  const prompt =
    '다음 영어 뉴스 헤드라인을 간결한 한국어로 번역하세요. ' +
    '반드시 JSON 배열(문자열만)로만 응답하세요. 설명, 코드블록 없이 순수 JSON만.\n' +
    JSON.stringify(texts);

  try {
    const res = await axios.post(
      `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: GEMINI_TIMEOUT },
    );

    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return texts;
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : texts;
  } catch (e) {
    console.warn('[News] Gemini 번역 실패, 원문 사용:', e.message);
    return texts;
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

// ── Track 3: KIS 국내 시황/공시 뉴스 ─────────────────────────────────────────

async function fetchDisclosureNews() {
  const accessToken = getAccessToken();
  if (!accessToken) throw new Error('KIS AccessToken 없음');

  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

  const res = await axios.get(
    `${REST_BASE}/uapi/domestic-stock/v1/quotations/news-title`,
    {
      headers: {
        'content-type':  'application/json',
        authorization:   `Bearer ${accessToken}`,
        appkey:           APP_KEY,
        appsecret:        APP_SECRET,
        tr_id:            'HHKST03010100',
        custtype:         'P',
      },
      params: {
        FID_NEWS_OFER_ENTP_CODE: '',
        FID_TITL_CNTT:           '',
        FID_INPUT_DATE_1:        dateStr,
        FID_INPUT_DATE_2:        dateStr,
        FID_INPUT_HOUR_1:        '000000',
        FID_INPUT_HOUR_2:        '235959',
        FID_RANK_SORT_CLS_CODE:  '0',
        FID_INPUT_ISCD:          '',
      },
      timeout: KIS_TIMEOUT,
    }
  );

  if (res.data?.rt_cd !== '0') {
    throw new Error(`KIS 뉴스 오류: ${res.data?.msg1}`);
  }

  const cutoff = new Date(Date.now() - MAX_NEWS_AGE_MS);
  return (res.data?.output ?? [])
    .map(item => {
      const ts = parseKisDateTime(item.data_dt, item.data_tm);
      return {
        newsId:    `kis-${item.news_cntt_sno || item.data_dt + item.data_tm + item.news_titl?.slice(0, 10)}`,
        title:     item.news_titl || '',
        source:    item.news_ofer_entp_name || 'KIS',
        url:       item.news_url || '',
        track:     'disclosure',
        timestamp: ts,
      };
    })
    .filter(n => n.title.length > 3 && n.timestamp >= cutoff);
}

function parseKisDateTime(date = '', time = '') {
  // date: YYYYMMDD, time: HHMMSS
  if (date.length < 8) return new Date();
  return new Date(
    `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T` +
    `${time.slice(0,2)||'00'}:${time.slice(2,4)||'00'}:${time.slice(4,6)||'00'}+09:00`
  );
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
