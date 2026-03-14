const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema({
  code:   { type: String, required: true, unique: true }, // 6자리 종목코드
  name:   { type: String, required: true },               // 한글명
  market: { type: String, enum: ['KOSPI', 'KOSDAQ'], required: true },
}, { versionKey: false });

stockSchema.index({ name: 1 });

module.exports = mongoose.model('Stock', stockSchema);
