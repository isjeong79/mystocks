const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  type:   { type: String, enum: ['domestic', 'foreign'], required: true },
  code:   { type: String },   // domestic
  symbol: { type: String },   // foreign
  name:   { type: String, required: true },
  market: { type: String },   // foreign (NAS/NYS/AMS)
}, { _id: false });

const watchlistSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items:  { type: [itemSchema], default: [] },
}, { versionKey: false });

module.exports = mongoose.model('Watchlist', watchlistSchema);
