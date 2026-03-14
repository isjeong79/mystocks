const delay = ms => new Promise(r => setTimeout(r, ms));

function signToDir(sign) {
  if (sign === '1' || sign === '2') return 'up';
  if (sign === '4' || sign === '5') return 'down';
  return 'flat';
}

function getKstNow() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 9 * 60) * 60000);
}

module.exports = { delay, signToDir, getKstNow };
