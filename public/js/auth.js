/**
 * 사용자 인증 (등록 / 로그인 / 로그아웃)
 * 의존: state.js, utils.js
 * reconnectWS는 main.js에서 init()으로 주입
 */

import { appState } from './state.js';
import { escHtml } from './utils.js';

let _reconnectWS;
let _onLogout;

export function init({ reconnectWS, onLogout }) {
  _reconnectWS = reconnectWS;
  _onLogout    = onLogout;

  document.getElementById('btn-logout').onclick    = doLogout;
  document.getElementById('btn-open-auth').onclick = openAuthModal;
  document.getElementById('btn-auth-cancel').onclick = closeAuthModal;
  document.getElementById('btn-register').onclick  = () => _doAuth('register');
  document.getElementById('btn-login').onclick     = () => _doAuth('login');
  document.getElementById('auth-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') _doAuth('login');
  });
  document.getElementById('auth-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAuthModal();
  });
}

export async function initAuth() {
  const userId = localStorage.getItem('userId');
  if (!userId) { _showAuthBtn(); return; }
  try {
    const res  = await fetch(`/api/auth/me?userId=${userId}`);
    const data = await res.json();
    if (data.userId) _setLoggedIn(data);
    else { localStorage.removeItem('userId'); _showAuthBtn(); }
  } catch { _showAuthBtn(); }
}

export function openAuthModal() {
  document.getElementById('auth-overlay').classList.add('open');
  document.getElementById('auth-error').textContent = '';
  setTimeout(() => document.getElementById('auth-input').focus(), 50);
}

export function closeAuthModal() {
  document.getElementById('auth-input').blur();
  document.getElementById('auth-overlay').classList.remove('open');
}

export function doLogout() {
  appState.currentUser = null;
  localStorage.removeItem('userId');
  _showAuthBtn();
  appState.watchlistItems = [];
  if (_onLogout) _onLogout();
  _reconnectWS();
}

function _setLoggedIn(user) {
  appState.currentUser = user;
  localStorage.setItem('userId', user.userId);
  document.getElementById('user-name').innerHTML = `<strong>${escHtml(user.username)}</strong> 님`;
  document.getElementById('user-name').style.display = 'inline';
  document.getElementById('btn-logout').style.display = '';
  document.getElementById('btn-open-auth').style.display = 'none';
  document.getElementById('update-section').style.display = user.username === '쑤' ? '' : 'none';
  _reconnectWS();
}

function _showAuthBtn() {
  document.getElementById('btn-open-auth').style.display = '';
  document.getElementById('user-name').style.display = 'none';
  document.getElementById('btn-logout').style.display = 'none';
  document.getElementById('update-section').style.display = 'none';
}

async function _doAuth(endpoint) {
  const username = document.getElementById('auth-input').value.trim();
  if (!username) { document.getElementById('auth-error').textContent = '사용자명을 입력하세요.'; return; }
  try {
    const res  = await fetch(`/api/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    if (data.error) { document.getElementById('auth-error').textContent = data.error; return; }
    closeAuthModal();
    _setLoggedIn(data);
  } catch { document.getElementById('auth-error').textContent = '서버 오류가 발생했습니다.'; }
}
