import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import AuthGate from './app/AuthGate';
import './theme/app.css';
import { applyTheme } from './stores/settings';
import { DEFAULT_SETTINGS } from './db/repo/settings';
import { installViewportTracking } from './app/viewport';

// 先套用預設主題（跟隨系統），避免登入與資料庫讀取期間閃白
applyTheme(DEFAULT_SETTINGS);
installViewportTracking();

// 監聽 Vite 動態模組載入失敗（伺服器部署新版造成舊版 chunk 雜湊 404 時自動重載）
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    window.location.reload();
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthGate />
    </BrowserRouter>
  </React.StrictMode>,
);
