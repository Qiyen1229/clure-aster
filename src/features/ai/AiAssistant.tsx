/**
 * Cilo（/ai）：智慧提醒（異常與訂閱偵測、預算預警，含目前的偵測結果）與 Cilo 額度。
 * 對話不在這一頁：記帳、查帳、問 AI、整理帳本、拍照記帳全部走全站同一個對話視窗（中央圓球往上滑、非記帳頁長按，或首頁小圓球）。
 * 舊網址相容：?q=問題或需求、?agent=需求、?tool=budget 會開啟對話視窗並自動送出，再把網址參數清掉。
 * 所有 AI 輸出都只當純文字顯示。
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AUTH_ENABLED } from '@/stores/auth';
import { getAiStatus, type AiStatus } from '@/services/ai';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';
import { SmartAlerts } from './SmartAlerts';
import { BUDGET_PROMPT, useChat } from '@/features/home/aiChatStore';

export default function AiAssistant() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const ai = useSettings((s) => s.ai);
  const [st, setSt] = useState<AiStatus | null>(null);
  const auto = (params.get('agent') ?? params.get('q') ?? (params.get('tool') === 'budget' ? BUDGET_PROMPT : '') ?? '').slice(0, 300);
  useEffect(() => { if (AUTH_ENABLED && ai?.enabled) getAiStatus().then(setSt).catch(() => undefined); }, [ai?.enabled]);
  // 舊連結帶需求進來：先清掉網址參數（重新整理不會再送一次），再開啟對話視窗送出（路由一變動對話視窗會收起，所以晚一拍再開）
  useEffect(() => {
    if (!auto) return;
    setParams({}, { replace: true });
    const t = window.setTimeout(() => useChat.getState().ask(auto), 80);
    return () => window.clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <header className="topbar">
      <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
      <h1>智慧偵測與預警</h1>
      <button className="icon-btn" aria-label="Cilo設定" onClick={() => navigate('/settings/ai')}><Icon name="sliders" /></button>
    </header>
  );

  return (
    <main className="page">
      {header}
      <SmartAlerts aiStatus={st} />
    </main>
  );
}
