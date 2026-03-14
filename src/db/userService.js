const User      = require('./models/User');
const Watchlist = require('./models/Watchlist');

async function registerUser(username) {
  const existing = await User.findOne({ username: username.trim() });
  if (existing) return { error: '이미 사용 중인 이름입니다.' };
  const user = await User.create({ username: username.trim() });
  // 빈 워치리스트 생성
  await Watchlist.create({ userId: user._id, items: [] });
  return { userId: user._id.toString(), username: user.username };
}

async function loginUser(username) {
  const user = await User.findOne({ username: username.trim() });
  if (!user) return { error: '등록되지 않은 사용자입니다.' };
  return { userId: user._id.toString(), username: user.username };
}

async function getUserById(userId) {
  try {
    const user = await User.findById(userId).lean();
    if (!user) return null;
    return { userId: user._id.toString(), username: user.username };
  } catch {
    return null;
  }
}

module.exports = { registerUser, loginUser, getUserById };
