'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  country:  { type: String, enum: ['KR', 'US'], required: true },
  year:     { type: Number, required: true },
  dates:    [String],   // 'YYYYMMDD'
  loadedAt: { type: Date, default: Date.now },
});
schema.index({ country: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('Holiday', schema);
