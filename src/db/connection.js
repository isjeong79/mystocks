const mongoose = require('mongoose');
const dns = require('dns');

// Node.js c-ares가 로컬 ISP DNS에 TCP SRV 조회 시 ECONNREFUSED 발생하는 문제 방지
// → Google DNS를 직접 사용하도록 강제
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

let _connected = false;

async function connectDB() {
  if (_connected) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI 환경변수 필요');
  await mongoose.connect(uri, { family: 4 });
  _connected = true;
  console.log('[MongoDB] 연결 완료');
}

module.exports = { connectDB };
