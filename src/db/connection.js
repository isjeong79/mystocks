const mongoose = require('mongoose');

let _connected = false;

async function connectDB() {
  if (_connected) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI 환경변수 필요');
  await mongoose.connect(uri);
  _connected = true;
  console.log('[MongoDB] 연결 완료');
}

module.exports = { connectDB };
