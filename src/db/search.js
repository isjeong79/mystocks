const Stock        = require('./models/Stock');
const ForeignStock = require('./models/ForeignStock');

const MAX_RESULTS = 10;

// ── 국내주식 검색 ─────────────────────────────────────────────────────────────
// 6자리 코드 → 정확히 일치 / 그 외 → 이름 prefix 검색
async function searchDomesticFromDB(q) {
  const trimmed = q.trim();
  if (!trimmed) return [];

  let docs;
  if (/^\d{6}$/.test(trimmed)) {
    // 코드 정확 검색
    docs = await Stock.find({ code: trimmed }).limit(1).lean();
  } else if (/^\d+$/.test(trimmed)) {
    // 숫자 코드 부분 검색
    docs = await Stock.find({ code: new RegExp('^' + trimmed) }).limit(MAX_RESULTS).lean();
  } else {
    // 이름 검색 (prefix 우선, 없으면 포함 검색)
    const regex  = new RegExp(trimmed, 'i');
    const prefix = new RegExp('^' + trimmed, 'i');
    const [prefixDocs, containsDocs] = await Promise.all([
      Stock.find({ name: prefix }).limit(MAX_RESULTS).lean(),
      Stock.find({ name: regex  }).limit(MAX_RESULTS).lean(),
    ]);
    // 중복 제거, prefix 결과 우선
    const seen = new Set(prefixDocs.map(d => d.code));
    docs = [...prefixDocs, ...containsDocs.filter(d => !seen.has(d.code))].slice(0, MAX_RESULTS);
  }

  return docs.map(d => ({
    code:     d.code,
    name:     d.name,
    exchange: d.market,
  }));
}

// ── 해외주식 검색 ─────────────────────────────────────────────────────────────
// 영문 티커 → symbol 정확/prefix 검색 / 그 외 → 한글명/영문명 포함 검색
async function searchForeignFromDB(q) {
  const trimmed = q.trim();
  if (!trimmed) return [];

  let docs;
  const upperQ = trimmed.toUpperCase();

  if (/^[A-Z0-9.]{1,10}$/i.test(trimmed)) {
    // 티커 검색: 정확 일치 우선 → prefix 검색
    const exact  = await ForeignStock.find({ symbol: upperQ }).limit(1).lean();
    const prefix = await ForeignStock.find({ symbol: new RegExp('^' + upperQ) }).limit(MAX_RESULTS).lean();
    const seen   = new Set(exact.map(d => d.symbol));
    docs = [...exact, ...prefix.filter(d => !seen.has(d.symbol))].slice(0, MAX_RESULTS);

    // 결과 없으면 이름도 검색
    if (!docs.length) {
      docs = await ForeignStock.find({
        $or: [{ nameKr: new RegExp(trimmed, 'i') }, { nameEn: new RegExp(trimmed, 'i') }],
      }).limit(MAX_RESULTS).lean();
    }
  } else {
    // 한글 또는 기타 → 이름 검색
    const regex = new RegExp(trimmed, 'i');
    docs = await ForeignStock.find({
      $or: [{ nameKr: regex }, { nameEn: regex }],
    }).limit(MAX_RESULTS).lean();
  }

  return docs.map(d => ({
    symbol:   d.symbol,
    name:     d.nameKr || d.nameEn || d.symbol,
    exchange: d.market,
    typeDisp: d.secType === 'etf' ? 'ETF' : 'Equity',
  }));
}

module.exports = { searchDomesticFromDB, searchForeignFromDB };
