const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true, trim: true },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

module.exports = mongoose.model('User', userSchema);
