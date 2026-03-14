// 전역 상태 저장소
const state = {
  stocks:      {},
  usEtfs:      {},
  forex:       { USDKRW: { rate: null, change: null, changeRate: null } },
  commodities: {
    WTI:   { price: null, change: null, changeRate: null },
    BRENT: { price: null, change: null, changeRate: null },
  },
  futures: { KOSPI_NIGHT: { price: null, change: null, changeRate: null } },
};

module.exports = state;
