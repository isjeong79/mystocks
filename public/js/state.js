/**
 * 앱 전역 공유 상태
 * 순환 의존성 방지를 위해 어떤 모듈도 import하지 않음
 */
export const appState = {
  currentUser:   null,  // { userId, username }
  watchlistItems: [],   // 현재 워치리스트 항목 배열
};
