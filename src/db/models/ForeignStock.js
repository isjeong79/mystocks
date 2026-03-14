const mongoose = require('mongoose');

const foreignStockSchema = new mongoose.Schema({
  symbol: { type: String, required: true, unique: true },
  nameKr: { type: String, default: '' },  // 한글명
  nameEn: { type: String, default: '' },  // 영문명
  market: { type: String, enum: ['NAS', 'NYS', 'AMS'], required: true },
  secType: { type: String, enum: ['stock', 'etf'], default: 'stock' },
}, { versionKey: false });

foreignStockSchema.index({ nameKr: 1 });
foreignStockSchema.index({ nameEn: 1 });

module.exports = mongoose.model('ForeignStock', foreignStockSchema);
