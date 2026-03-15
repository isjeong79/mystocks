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

// 구글 뉴스 국내 경제 검색 키워드 (OR 조합 → 속보 범위 최대화)
const DOMESTIC_KEYWORDS = [
  '코스피', '코스닥', '증시', '한국은행', '기준금리', '금리', '환율',
  'AI', '원자력', '전력', '자동차', '바이오', '부동산정책',
  '반도체', '이차전지', '공시', '금융위', '수출입',
];

const RSS = {
  GOOGLE_NEWS: 'https://news.google.com/rss/search?q=' +
    encodeURIComponent(DOMESTIC_KEYWORDS.join(' OR ')) +
    '&hl=ko&gl=KR&ceid=KR:ko',
  NEWSPIM_ECONOMY:  'http://rss.newspim.com/news/category/103',  // 경제
  NEWSPIM_FINANCE:  'http://rss.newspim.com/news/category/105',  // 증권·금융
  MT_NEWS:   'https://rss.mt.co.kr/mt_news.xml',               // 머니투데이 종합
  MK_STOCK:  'https://www.mk.co.kr/rss/50200011/',             // 매일경제 증권
  YONHAP:    'https://www.yna.co.kr/rss/economy.xml',
  CNBC:      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000311',
  INVESTING: 'https://www.investing.com/rss/news.rss',
};

const RSS_TIMEOUT     = 10_000;
const MAX_NEWS_AGE_MS = 12 * 60 * 60 * 1000;  // 12시간 (4시간이면 오래된 RSS 기사 누락)
const GLOBAL_MAX      = 12;                    // 번역 전 최대 해외 뉴스 수
const DUP_PREFIX_LEN  = 15;                    // 수집 내부 중복 판정 prefix 길이 (자)
const BROADCAST_MAX   = 50;                    // 티커 브로드캐스트 최대 건수

// 머니투데이 종합피드 경제/증권 키워드 필터 (비관련 뉴스 제외)
const MT_KEYWORDS = [
  '주식', '증시', '코스피', '코스닥', '펀드', '채권', '금리', '환율', '달러',
  '수출', '수입', '무역', '관세', '반도체', '배터리', '이차전지', '바이오',
  '상장', '공모', '실적', '영업이익', '매출', '투자', '인수', '합병', 'M&A',
  '원자력', '전력', '에너지', 'IPO', '스타트업', '벤처', 'AI', '인공지능',
  '부동산', '금융', '은행', '보험', '증권', '자산', '경제', '물가', '인플레',
  '한국은행', '기준금리', '연준', '연방', 'Fed', '나스닥', 'S&P',
  '삼성', 'SK', 'LG', '현대', '카카오', '네이버', '셀트리온', '포스코',
];
const MT_KEYWORD_RE = new RegExp(MT_KEYWORDS.join('|'), 'i');

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

// ── HTML 엔티티 디코더 ────────────────────────────────────────────────────────
// RSS 피드가 &amp;#039; 처럼 이중 인코딩된 엔티티를 포함하는 경우 정규화
function decodeHtml(str) {
  return String(str || '')
    .replace(/&#(\d+);/g,   (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&amp;/g,  '&');
}

// ── 소스별 장애 격리 헬퍼 ─────────────────────────────────────────────────────
/**
 * fetchFn 실행 시 예외가 발생해도 fallback 을 반환하고 경고만 출력
 * → Promise.all 안에서 사용하면 한 소스 실패가 전체를 중단시키지 않음
 */
async function safeRssFetch(name, fetchFn, fallback = []) {
  try {
    return await fetchFn();
  } catch (e) {
    console.warn(`[News] ${name} 실패:`, e.message);
    return fallback;
  }
}

// ── Investing.com 서킷 브레이커 ───────────────────────────────────────────────
// 403/429/451 차단 감지 시 1시간 쿨다운 → 불필요한 반복 요청 방지
let _investingCooldownUntil = 0;
const INVESTING_COOLDOWN_MS  = 60 * 60 * 1000; // 1시간
const INVESTING_BLOCK_CODES  = new Set([403, 429, 451]);

// ── 유틸: 15자 prefix 중복 제거 ──────────────────────────────────────────────

/**
 * titleField 기준으로 앞 DUP_PREFIX_LEN 자가 동일한 항목을 제거
 * (먼저 나온 항목 유지, 이후 항목 제거)
 */
function deduplicateByPrefix(items, titleField = 'headline', prefixLen = DUP_PREFIX_LEN) {
  const seen = new Set();
  return items.filter(item => {
    const prefix = String(item[titleField] || '')
      .slice(0, prefixLen)
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
  // 차단 쿨다운 중이면 즉시 스킵 (표시/저장/번역 없음)
  if (Date.now() < _investingCooldownUntil) {
    const mins = Math.ceil((_investingCooldownUntil - Date.now()) / 60000);
    throw new Error(`Investing.com 쿨다운 중 (${mins}분 남음)`);
  }

  try {
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
  } catch (e) {
    // HTTP 상태코드 추출 (rss-parser는 에러 메시지에 코드 포함)
    const status = e.status ?? e.response?.status
      ?? (String(e.message).match(/(?:status code\s*|HTTP\s*)(\d{3})/i)?.[1] | 0);

    if (INVESTING_BLOCK_CODES.has(status)) {
      _investingCooldownUntil = Date.now() + INVESTING_COOLDOWN_MS;
      console.warn(`[News] Investing.com 차단 감지 (HTTP ${status}) → 1시간 스킵`);
    }
    throw e; // safeRssFetch가 받아서 나머지 소스는 정상 처리
  }
}

// ── Track 1: 해외 뉴스 통합 (번역 포함) ──────────────────────────────────────

async function fetchGlobalNews() {
  const cutoff = Date.now() - MAX_NEWS_AGE_MS;

  // 3개 해외 소스 병렬 수집 (소스별 개별 try-catch → 한 소스 실패가 나머지에 영향 없음)
  const [finnhubItems, cnbcItems, investingItems] = await Promise.all([
    safeRssFetch('Finnhub',       () => _fetchFinnhubRaw(cutoff)),
    safeRssFetch('CNBC',          () => _fetchCNBCRaw(cutoff)),
    safeRssFetch('Investing.com', () => _fetchInvestingRaw(cutoff)),
  ]);

  const raw = [...finnhubItems, ...cnbcItems, ...investingItems];

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

  const EMPTY_FEED = { items: [] };

  // 5개 국내 소스 병렬 수집 (소스별 개별 try-catch → 한 소스 실패가 나머지에 영향 없음)
  const [googleFeed, newspimEcoFeed, newspimFinFeed, mtFeed, mkFeed] = await Promise.all([
    safeRssFetch('Google News', () => rssParser.parseURL(RSS.GOOGLE_NEWS),      EMPTY_FEED),
    safeRssFetch('뉴스핌(경제)', () => rssParser.parseURL(RSS.NEWSPIM_ECONOMY), EMPTY_FEED),
    safeRssFetch('뉴스핌(증권)', () => rssParser.parseURL(RSS.NEWSPIM_FINANCE), EMPTY_FEED),
    safeRssFetch('머니투데이',   () => rssParser.parseURL(RSS.MT_NEWS),         EMPTY_FEED),
    safeRssFetch('매일경제',     () => rssParser.parseURL(RSS.MK_STOCK),        EMPTY_FEED),
  ]);

  const parseFeedItems = (feed, prefix, sourceName, keywordRe = null) =>
    (feed.items ?? [])
      .filter(item => new Date(item.pubDate || 0) >= cutoff)
      .map(item => ({
        newsId:    `${prefix}-${Buffer.from(item.link || item.title || '').toString('base64').slice(0, 40)}`,
        title:     decodeHtml((item.title || '').trim()),
        source:    sourceName,
        url:       item.link || '',
        track:     'domestic',
        timestamp: new Date(item.pubDate || Date.now()),
      }))
      .filter(n => n.title.length > 5)
      .filter(n => !keywordRe || keywordRe.test(n.title));

  // 구글뉴스: pubDate 없는 항목은 Invalid Date → cutoff 비교 false → 자동 제외
  // track: 'domestic' 고정 → fetchGlobalNews와 완전 분리 → DeepL 호출 없음
  const googleRaw = (googleFeed.items ?? [])
    .filter(item => new Date(item.pubDate) >= cutoff)
    .map(item => ({
      newsId:    `gnews-${Buffer.from(item.link || item.title || '').toString('base64').slice(0, 40)}`,
      title:     decodeHtml((item.title || '').replace(/\s*-\s*[^-]+$/, '').trim()),
      source:    extractRssSource(item.title) || '구글뉴스',
      url:       item.link || '',
      track:     'domestic',
      timestamp: new Date(item.pubDate),
    }))
    .filter(n => n.title.length > 5);

  // 구글뉴스 내 중복 엄격 제거 (20자 prefix) - 키워드 확장으로 동일 기사 다중 노출 방지
  const googleItems = deduplicateByPrefix(googleRaw, 'title', 20);

  // 합산 후 최신순 정렬
  return [
    ...googleItems,
    ...parseFeedItems(newspimEcoFeed, 'newspim-eco', '뉴스핌'),
    ...parseFeedItems(newspimFinFeed, 'newspim-fin', '뉴스핌'),
    ...parseFeedItems(mtFeed,         'mt',          '머니투데이', MT_KEYWORD_RE),
    ...parseFeedItems(mkFeed,         'mk',          '매일경제'),
  ].sort((a, b) => b.timestamp - a.timestamp);
}

/** RSS 제목 끝의 " - 출처명" 패턴에서 출처 추출 */
function extractRssSource(title = '') {
  const m = title.match(/[-–]\s*([^-–]+?)\s*$/);
  return m ? m[1].trim() : '';
}

// ── Track 3: 공시/시황 (연합뉴스 경제) ───────────────────────────────────────

async function fetchDisclosureNews() {
  const feed = await safeRssFetch('연합뉴스', () => rssParser.parseURL(RSS.YONHAP), { items: [] });
  const cutoff = new Date(Date.now() - MAX_NEWS_AGE_MS);

  return (feed.items ?? [])
    .filter(item => new Date(item.pubDate) >= cutoff)
    .map(item => ({
      newsId:    `yna-${Buffer.from(item.link || item.title || '').toString('base64').slice(0, 40)}`,
      title:     decodeHtml((item.title || '').trim()),
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

  // newsId 기준 중복 제거만 수행 → title 중복 제거는 DB 저장 전에 하지 않음
  // (title 중복 제거를 여기서 하면 DB에 쌓이는 기사 수가 급감)
  const unique = [...new Map(all.map(n => [n.newsId, n])).values()];

  // 번역 실패한 global 뉴스는 DB 저장 제외 (다음 주기 재시도)
  const toSave = unique.filter(n =>
    n.track !== 'global' ||
    !n.headline_original ||
    n.title !== n.headline_original
  );

  // insertMany ordered:false → 중복 newsId 무시, 신규만 삽입
  try {
    const result = await News.insertMany(toSave, { ordered: false });
    console.log(`[News] DB insert: ${result.length}건 신규`);
  } catch (e) {
    if (e.name === 'MongoBulkWriteError' || e.code === 11000) {
      const inserted = e.insertedCount ?? e.result?.insertedCount ?? e.result?.nInserted ?? (toSave.length - (e.writeErrors?.length ?? 0));
      console.log(`[News] DB insert (일부 중복): ${inserted}건 신규`);
    } else {
      console.error('[News] DB insert 실패:', e.message);
      return [];
    }
  }

  // DB 누적 기사 조회 → 여기서만 title 중복 제거 → 브로드캐스트
  const cutoffDate = new Date(Date.now() - MAX_NEWS_AGE_MS);
  const recent = await News.find(
    { timestamp: { $gte: cutoffDate } },
    { newsId: 1, title: 1, source: 1, url: 1, track: 1, timestamp: 1 }
  ).sort({ timestamp: -1 }).limit(BROADCAST_MAX * 3).lean();

  const normalized = recent.map(n => ({ ...n, title: decodeHtml(n.title) }));

  // 브로드캐스트용 dedup은 20자 기준 — 15자면 다른 기사도 과도하게 제거됨
  return deduplicateByPrefix(normalized, 'title', 20)
    .slice(0, BROADCAST_MAX);
}

module.exports = { aggregateAndSave };
