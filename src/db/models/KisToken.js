const mongoose = require('mongoose');

const KisTokenSchema = new mongoose.Schema({
  appKey:      { type: String, required: true, unique: true },
  accessToken: { type: String, required: true },
  expiresAt:   { type: Date,   required: true },
}, { timestamps: true });

module.exports = mongoose.model('KisToken', KisTokenSchema);
