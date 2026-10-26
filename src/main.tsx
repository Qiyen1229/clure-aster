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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthGate />
    </BrowserRouter>
  </React.StrictMode>,
);
