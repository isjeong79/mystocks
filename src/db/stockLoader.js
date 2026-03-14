/**
 * KIS 종목 마스터 데이터 다운로드 및 MongoDB 저장
 *
 * 국내: https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip
 *       https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip
 * 해외: https://new.real.download.dws.co.kr/common/master/{val}mst.cod.zip
 *       val: nas(NASDAQ), nys(NYSE), ams(AMEX)
 */

const axios   = require('axios');
const AdmZip  = require('adm-zip');
const iconv   = require('iconv-lite');
const Stock        = require('./models/Stock');
const ForeignStock = require('./models/ForeignStock');

const KIS_DOWNLOAD_BASE = 'https://new.real.download.dws.co.kr/common/master';

// ── 공통: ZIP 다운로드 → 첫 번째 파일 버퍼 반환 ─────────────────────────────
async function downloadZip(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const zip   = new AdmZip(Buffer.from(res.data));
  const entry = zip.getEntries()[0];
  if (!entry) throw new Error(`ZIP에 파일 없음: ${url}`);
  return entry.getData();
}

// ── 국내 MST 파싱 (KOSPI: part2=228자, KOSDAQ: part2=222자) ─────────────────
function parseKoreanMst(buffer, market) {
  const PART2_WIDTH = market === 'KOSPI' ? 228 : 222;
  const content = iconv.decode(buffer, 'cp949');
  const lines   = content.split('\n');
  const stocks  = [];

  for (const line of lines) {
    // 유효 라인: part2 이후 part1이 최소 9자 이상이어야 함
    if (line.length <= PART2_WIDTH + 9) continue;
    const part1 = line.substring(0, line.length - PART2_WIDTH);
    const code  = part1.substring(0, 9).trimEnd();   // 단축코드 (6자리, 우측 공백 제거)
    const name  = part1.substring(21).trim();          // 한글명
    // 6자리 숫자 코드만 저장 (ETF, 우선주 등 포함)
    if (!code || !name || !/^\d{6}$/.test(code)) continue;
    stocks.push({ code, name, market });
  }
  return stocks;
}

// ── 해외 COD 파싱 (탭 구분, CP949) ──────────────────────────────────────────
// 컬럼 순서: 0:국가코드, 1:거래소ID, 2:거래소코드, 3:거래소명, 4:Symbol,
//            5:실시간Symbol, 6:한글명, 7:영문명, 8:종목유형(2:주식,3:ETF/ETP)
function parseForeignCod(buffer, market) {
  const content = iconv.decode(buffer, 'cp949');
  const lines   = content.split('\n');
  const stocks  = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols   = line.split('\t');
    if (cols.length < 9) continue;
    const symbol  = cols[4]?.trim();
    const nameKr  = cols[6]?.trim() ?? '';
    const nameEn  = cols[7]?.trim() ?? '';
    const secType = cols[8]?.trim();
    if (!symbol) continue;
    // 주식(2), ETF/ETP(3)만 저장. 인덱스(1), 워런트(4) 제외
    if (secType !== '2' && secType !== '3') continue;
    stocks.push({
      symbol,
      nameKr,
      nameEn,
      market,
      secType: secType === '3' ? 'etf' : 'stock',
    });
  }
  return stocks;
}

// ── 국내주식 로드 ────────────────────────────────────────────────────────────
async function loadDomesticStocks(onProgress) {
  const markets = [
    { market: 'KOSPI',  url: `${KIS_DOWNLOAD_BASE}/kospi_code.mst.zip` },
    { market: 'KOSDAQ', url: `${KIS_DOWNLOAD_BASE}/kosdaq_code.mst.zip` },
  ];

  let total = 0;
  for (const { market, url } of markets) {
    onProgress?.(`[종목로더] ${market} 다운로드 중...`);
    const buffer = await downloadZip(url);
    const stocks = parseKoreanMst(buffer, market);
    onProgress?.(`[종목로더] ${market} ${stocks.length}개 파싱 완료 → DB 저장 중...`);

    // 기존 데이터 삭제 후 bulk insert
    await Stock.deleteMany({ market });
    const ops = stocks.map(s => ({
      updateOne: {
        filter: { code: s.code },
        update: { $set: s },
        upsert: true,
      },
    }));
    if (ops.length) await Stock.bulkWrite(ops, { ordered: false });
    total += stocks.length;
    onProgress?.(`[종목로더] ${market} ${stocks.length}개 저장 완료`);
  }
  return total;
}

// ── 해외주식 로드 ────────────────────────────────────────────────────────────
async function loadForeignStocks(onProgress) {
  const markets = [
    { market: 'NAS', val: 'nas' },
    { market: 'NYS', val: 'nys' },
    { market: 'AMS', val: 'ams' },
  ];

  let total = 0;
  for (const { market, val } of markets) {
    const url = `${KIS_DOWNLOAD_BASE}/${val}mst.cod.zip`;
    onProgress?.(`[종목로더] ${market} 다운로드 중...`);
    const buffer = await downloadZip(url);
    const stocks = parseForeignCod(buffer, market);
    onProgress?.(`[종목로더] ${market} ${stocks.length}개 파싱 완료 → DB 저장 중...`);

    await ForeignStock.deleteMany({ market });
    const ops = stocks.map(s => ({
      updateOne: {
        filter: { symbol: s.symbol, market: s.market },
        update: { $set: s },
        upsert: true,
      },
    }));
    if (ops.length) await ForeignStock.bulkWrite(ops, { ordered: false });
    total += stocks.length;
    onProgress?.(`[종목로더] ${market} ${stocks.length}개 저장 완료`);
  }
  return total;
}

// ── 전체 업데이트 ────────────────────────────────────────────────────────────
async function updateAllStocks(onProgress) {
  const t0 = Date.now();
  const domestic = await loadDomesticStocks(onProgress);
  const foreign  = await loadForeignStocks(onProgress);
  const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
  const msg = `[종목로더] 완료: 국내 ${domestic}개, 해외 ${foreign}개 (${elapsed}초)`;
  onProgress?.(msg);
  console.log(msg);
  return { domestic, foreign };
}

// ── 초기화: DB가 비어있으면 자동 로드 ────────────────────────────────────────
async function ensureStocksLoaded() {
  const [domesticCount, foreignCount] = await Promise.all([
    Stock.estimatedDocumentCount(),
    ForeignStock.estimatedDocumentCount(),
  ]);
  if (domesticCount === 0 || foreignCount === 0) {
    console.log('[종목로더] 종목 DB 없음 → 자동 다운로드 시작');
    await updateAllStocks(msg => console.log(msg));
  } else {
    console.log(`[종목로더] 기존 데이터 사용: 국내 ${domesticCount}개, 해외 ${foreignCount}개`);
  }
}

module.exports = { updateAllStocks, ensureStocksLoaded };
