const mongoose = require('mongoose');

/**
 * News 스키마
 * - TTL 인덱스: createdAt에 expires:'2d' 설정 → MongoDB가 48시간 후 자동 삭제
 * - newsId: 중복 방지용 unique key (finnhub id / rss guid / kis 고유번호)
 * - track: 'global' | 'domestic' | 'disclosure'
 */
const newsSchema = new mongoose.Schema({
  newsId:    { type: String, required: true, unique: true },
  title:     { type: String, required: true },
  source:    { type: String, required: true },
  url:       { type: String, default: '' },
  track:     { type: String, enum: ['global', 'domestic', 'disclosure'], required: true },
  timestamp: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now, expires: '2d' },  // TTL 인덱스
});

module.exports = mongoose.model('News', newsSchema);
