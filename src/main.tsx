import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import AuthGate from './app/AuthGate';
import { ConfirmHost, InputHost } from './app/overlays';
import './theme/app.css';
import { applyTheme } from './stores/settings';
import { DEFAULT_SETTINGS } from './db/repo/settings';
import { installViewportTracking } from './app/viewport';
import { initGlobalErrorLogging } from './services/errorLog';

// 啟動全域錯誤捕捉與本機錯誤日誌記錄
initGlobalErrorLogging();

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

// 數字欄位一點進去就全選：要改的時候直接輸入或一鍵刪除（全站共用，不必每個欄位各自處理）
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return;
    const mode = el.inputMode;
    if (el.type === 'number' || mode === 'decimal' || mode === 'numeric') setTimeout(() => { if (document.activeElement === el) el.select(); }, 0);
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthGate />
      {/* 確認視窗放在最外層：登入前的畫面（例如刪除舊資料）也要能跳出 */}
      <ConfirmHost />
      <InputHost />
    </BrowserRouter>
  </React.StrictMode>,
);
