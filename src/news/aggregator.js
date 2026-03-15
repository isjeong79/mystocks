/**
 * 5-Source 뉴스 통합 모듈
 *
 * Track 1 (global)     : Finnhub + CNBC + Investing.com → DeepL 번역 (단일 배치)
 * Track 2 (domestic)   : Google News RSS + 뉴스핌 (한국어)
 * Track 3 (disclosure) : 연합뉴스 경제 RSS (한국어)
 *
 * - 모든 소스 Promise.allSettled 장애 격리
 * - 해외 뉴스: 최신순 정렬 → 15자 prefix 중복 제거 → 상위 12건 → DeepL 1회 배치
 * - 번역 성공 항목만 DB 캐시 (번역 실패 시 저장 제외 → 다음 주기 재시도)
 * - 최종 수집 후 전체 15자 prefix 중복 제거 (cross-track 중복 방어)
 * - MongoDB TTL(2d) 기반 자동 만료
 */

'use strict';

const axios     = require('axios');
const RSSParser = require('rss-parser');
const News      = require('../db/models/News');

// ── 상수 ─────────────────────────────────────────────────────────────────────

const FINNHUB_BASE  = 'https://finnhub.io/api/v1';
// 무료 플랜 키는 :fx 로 끝남. 유료라면 'https://api.deepl.com/v2' 로 변경
const DEEPL_BASE    = 'https://api-free.deepl.com/v2';
const DEEPL_TIMEOUT = 15_000;

const RSS = {
  GOOGLE_NEWS: 'https://news.google.com/rss/search?q=' +
    encodeURIComponent('코스피 OR 한국은행 OR 금융위 OR 기준금리 OR 코스닥') +
    '&hl=ko&gl=KR&ceid=KR:ko',
  NEWSPIM:   'https://www.newspim.com/rss/economy',
  YONHAP:    'https://www.yna.co.kr/rss/economy.xml',
  CNBC:      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000311',
  INVESTING: 'https://www.investing.com/rss/news.rss',
};

const RSS_TIMEOUT     = 10_000;
const MAX_NEWS_AGE_MS = 4 * 60 * 60 * 1000;  // 4시간
const GLOBAL_MAX      = 12;                    // 번역 전 최대 해외 뉴스 수
const DUP_PREFIX_LEN  = 15;                    // 중복 판정 prefix 길이 (자)

// Finnhub 전용 키워드 필터 (일반 뉴스 중 금융/거시 관련만 추출)
const GLOBAL_KEYWORDS = [
  'Fed', 'Federal Reserve', 'FOMC', 'Powell', 'rate cut', 'rate hike',
  'interest rate', 'CPI', 'inflation', 'GDP', 'recession', 'yield',
  'War', 'Ukraine', 'Russia', 'Israel', 'Gaza', 'Taiwan', 'Iran',
  'sanctions', 'tariff',
  'Apple', 'Microsoft', 'Nvidia', 'Amazon', 'Alphabet', 'Google', 'Meta',
  'Tesla', 'Broadcom', 'TSMC', 'AMD', 'Netflix', 'Eli Lilly',
  'Berkshire', 'JPMorgan', 'Visa', 'Mastercard', 'UnitedHealth', 'Exxon',
  'S&P 500', 'Nasdaq', 'Dow Jones', 'VIX', 'Treasury', 'dollar', 'DXY',
  'earnings', 'IPO', 'M&A', 'layoffs', 'bankruptcy', 'merger',
];
const KEYWORD_RE = new RegExp(GLOBAL_KEYWORDS.join('|'), 'i');

const rssParser = new RSSParser({ timeout: RSS_TIMEOUT });

// ── 유틸: 15자 prefix 중복 제거 ──────────────────────────────────────────────

/**
 * titleField 기준으로 앞 DUP_PREFIX_LEN 자가 동일한 항목을 제거
 * (먼저 나온 항목 유지, 이후 항목 제거)
 */
function deduplicateByPrefix(items, titleField = 'headline') {
  const seen = new Set();
  return items.filter(item => {
    const prefix = String(item[titleField] || '')
      .slice(0, DUP_PREFIX_LEN)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!prefix || seen.has(prefix)) return false;
    seen.add(prefix);
    return true;
  });
}

// ── Track 1 서브: Finnhub 원시 수집 ──────────────────────────────────────────

async function _fetchFinnhubRaw(cutoff) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error('FINNHUB_API_KEY 미설정');

  const res = await axios.get(`${FINNHUB_BASE}/news`, {
    params: { category: 'general', token: apiKey },
    timeout: 10_000,
  });

  return (res.data ?? [])
    .filter(item =>
      KEYWORD_RE.test(item.headline) &&
      item.datetime * 1000 >= cutoff
    )
    .map(item => ({
      newsId:    `finnhub-${item.id}`,
      headline:  item.headline,
      source:    item.source || 'Finnhub',
      url:       item.url || '',
      timestamp: new Date(item.datetime * 1000),
    }));
}

// ── Track 1 서브: CNBC RSS 원시 수집 ─────────────────────────────────────────

async function _fetchCNBCRaw(cutoff) {
  const feed = await rssParser.parseURL(RSS.CNBC);
  const cutoffDate = new Date(cutoff);

  return (feed.items ?? [])
    .filter(item => new Date(item.pubDate || 0) >= cutoffDate)
    .map(item => {
      const id = Buffer.from(item.link || item.title || '').toString('base64').slice(0, 40);
      return {
        newsId:    `cnbc-${id}`,
        headline:  (item.title || '').trim(),
        source:    'CNBC',
        url:       item.link || '',
        timestamp: new Date(item.pubDate || Date.now()),
      };
    })
    .filter(n => n.headline.length > 5);
}

// ── Track 1 서브: Investing.com RSS 원시 수집 ─────────────────────────────────

async function _fetchInvestingRaw(cutoff) {
  const feed = await rssParser.parseURL(RSS.INVESTING);
  const cutoffDate = new Date(cutoff);

  return (feed.items ?? [])
    .filter(item => new Date(item.pubDate || 0) >= cutoffDate)
    .map(item => {
      const id = Buffer.from(item.link || item.title || '').toString('base64').slice(0, 40);
      return {
        newsId:    `inv-${id}`,
        headline:  (item.title || '').trim(),
        source:    'Investing.com',
        url:       item.link || '',
        timestamp: new Date(item.pubDate || Date.now()),
      };
    })
    .filter(n => n.headline.length > 5);
}

// ── Track 1: 해외 뉴스 통합 (번역 포함) ──────────────────────────────────────

async function fetchGlobalNews() {
  const cutoff = Date.now() - MAX_NEWS_AGE_MS;

  // 3개 해외 소스 병렬 수집 (소스별 장애 격리)
  const [rFinnhub, rCNBC, rInvesting] = await Promise.allSettled([
    _fetchFinnhubRaw(cutoff),
    _fetchCNBCRaw(cutoff),
    _fetchInvestingRaw(cutoff),
  ]);

  if (rFinnhub.status  === 'rejected') console.warn('[News] Finnhub 실패:', rFinnhub.reason?.message);
  if (rCNBC.status     === 'rejected') console.warn('[News] CNBC 실패:', rCNBC.reason?.message);
  if (rInvesting.status === 'rejected') console.warn('[News] Investing 실패:', rInvesting.reason?.message);

  const raw = [
    ...(rFinnhub.status  === 'fulfilled' ? rFinnhub.value  : []),
    ...(rCNBC.status     === 'fulfilled' ? rCNBC.value     : []),
    ...(rInvesting.status === 'fulfilled' ? rInvesting.value : []),
  ];

  if (raw.length === 0) return [];

  // 최신순 → 영문 prefix 중복 제거 → 상위 GLOBAL_MAX개
  const sliced = deduplicateByPrefix(
    raw.sort((a, b) => b.timestamp - a.timestamp)
  ).slice(0, GLOBAL_MAX);

  // DB 조회: 번역 성공 항목(headline_original 설정 + title 다름)만 캐시 재사용
  const candidateIds = sliced.map(item => item.newsId);
  const existing = await News.find(
    { newsId: { $in: candidateIds } },
    { newsId: 1, title: 1, headline_original: 1 }
  ).lean();

  const existingMap = new Map(
    existing
      .filter(n => n.headline_original && n.title !== n.headline_original)
      .map(n => [n.newsId, n.title])
  );

  // 신규 + 번역 미완료 항목 → DeepL 단일 배치
  const newItems = sliced.filter(item => !existingMap.has(item.newsId));
  let translatedTitles = null;
  if (newItems.length > 0) {
    translatedTitles = await translateWithDeepL(newItems.map(i => i.headline));
  }

  return sliced.map(item => {
    const title = existingMap.has(item.newsId)
      ? existingMap.get(item.newsId)
      : (() => {
          const idx = newItems.findIndex(n => n.newsId === item.newsId);
          return (translatedTitles && idx >= 0 && translatedTitles[idx])
            ? translatedTitles[idx]
            : item.headline;
        })();

    return {
      newsId:            item.newsId,
      title,
      headline_original: item.headline,
      source:            item.source,
      url:               item.url,
      track:             'global',
      timestamp:         item.timestamp,
    };
  });
}

// ── DeepL 번역 ────────────────────────────────────────────────────────────────

/**
 * 헤드라인 배열을 DeepL로 한국어 번역
 * 반환: 번역문 배열 (입력과 동일 순서) | null (실패 시)
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

// ── Track 2: 국내 거시 (Google News + 뉴스핌) ────────────────────────────────

async function fetchDomesticNews() {
  const cutoff = new Date(Date.now() - MAX_NEWS_AGE_MS);

  const [rGoogle, rNewspim] = await Promise.allSettled([
    rssParser.parseURL(RSS.GOOGLE_NEWS),
    rssParser.parseURL(RSS.NEWSPIM),
  ]);

  if (rGoogle.status  === 'rejected') console.warn('[News] Google News 실패:', rGoogle.reason?.message);
  if (rNewspim.status === 'rejected') console.warn('[News] 뉴스핌 실패:', rNewspim.reason?.message);

  const googleItems = rGoogle.status === 'fulfilled'
    ? (rGoogle.value.items ?? [])
        .filter(item => new Date(item.pubDate) >= cutoff)
        .map(item => ({
          newsId:    `gnews-${Buffer.from(item.link || item.title || '').toString('base64').slice(0, 40)}`,
          title:     (item.title || '').replace(/\s*-\s*[^-]+$/, '').trim(),
          source:    extractRssSource(item.title) || '구글뉴스',
          url:       item.link || '',
          track:     'domestic',
          timestamp: new Date(item.pubDate || Date.now()),
        }))
        .filter(n => n.title.length > 5)
    : [];

  const newspimItems = rNewspim.status === 'fulfilled'
    ? (rNewspim.value.items ?? [])
        .filter(item => new Date(item.pubDate || 0) >= cutoff)
        .map(item => ({
          newsId:    `newspim-${Buffer.from(item.link || item.title || '').toString('base64').slice(0, 40)}`,
          title:     (item.title || '').trim(),
          source:    '뉴스핌',
          url:       item.link || '',
          track:     'domestic',
          timestamp: new Date(item.pubDate || Date.now()),
        }))
        .filter(n => n.title.length > 5)
    : [];

  // 합산 후 최신순 정렬
  return [...googleItems, ...newspimItems]
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** RSS 제목 끝의 " - 출처명" 패턴에서 출처 추출 */
function extractRssSource(title = '') {
  const m = title.match(/[-–]\s*([^-–]+?)\s*$/);
  return m ? m[1].trim() : '';
}

// ── Track 3: 공시/시황 (연합뉴스 경제) ───────────────────────────────────────

async function fetchDisclosureNews() {
  const feed = await rssParser.parseURL(RSS.YONHAP);
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
 * 3-Track 병렬 수집 → cross-track 중복 제거 → 신규 항목 DB insert
 * 실패한 Track은 경고만 남기고 무시 (장애 격리)
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

  const all = [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
  ];

  if (all.length === 0) return [];

  // newsId 기준 중복 제거
  const unique = [...new Map(all.map(n => [n.newsId, n])).values()];

  // cross-track 유사 제목 중복 제거 (앞 15자 일치)
  const deduped = deduplicateByPrefix(
    unique.sort((a, b) => b.timestamp - a.timestamp),
    'title'
  );

  // 번역 실패한 global 뉴스는 DB 저장 제외 (다음 주기 재시도)
  const toSave = deduped.filter(n =>
    n.track !== 'global' ||
    !n.headline_original ||
    n.title !== n.headline_original
  );

  // insertMany ordered:false → 중복 키 무시, 나머지 삽입
  try {
    const result = await News.insertMany(toSave, { ordered: false });
    console.log(`[News] DB insert: ${result.length}건 신규`);
  } catch (e) {
    if (e.name === 'MongoBulkWriteError' || e.code === 11000) {
      console.log(`[News] DB insert (일부 중복): ${e.result?.nInserted ?? '?'}건 신규`);
    } else {
      console.error('[News] DB insert 실패:', e.message);
      return [];
    }
  }

  // timestamp 내림차순, 최신 30건 브로드캐스트
  return deduped
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 30);
}

module.exports = { aggregateAndSave };
