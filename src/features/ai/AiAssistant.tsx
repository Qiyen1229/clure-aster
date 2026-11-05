/**
 * AI 助理（/ai）：記帳、查帳、問 AI、整理帳本、拍照記帳全部走同一個對話框（features/home/AiChat.tsx 的 ChatPanel，與首頁小圓球同一份對話）。
 * 這一頁只多放對話以外的東西：智慧提醒（含目前的偵測結果）。白話解讀請在對話框問，或到報表、帳戶、專案頁的「AI 解說」。
 * 所有 AI 輸出都只當純文字顯示。網址參數：?q=問題或需求（自動送出）、?agent=需求（同 ?q=）、?tool=budget（自動請操作助手規劃預算）
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AUTH_ENABLED } from '@/stores/auth';
import { getAiStatus, type AiStatus } from '@/services/ai';
import { useSettings } from '@/stores/settings';
import { AiMark, Icon } from '@/ui/Icon';
import { SmartAlerts } from './SmartAlerts';
import { NewMark } from '@/ui/NewMark';
import { useChat } from '@/features/home/aiChatStore';

/** 舊連結 /ai?tool=budget：改由對話框的操作助手規劃（先預覽、確認才建立、可還原） */
const BUDGET_PROMPT = '依過去 3 個月的花費，幫我設定各分類的每月預算';

const ChatPanel = lazy(() => import('@/features/home/AiChat').then((m) => ({ default: m.ChatPanel })));

// ───────────── 頁面 ─────────────

/** AI 對話：記帳、查帳、問 AI、用說的整理帳本全部在同一個輸入框（和首頁 AI 小圓球的對話是同一份）；?q= 或 ?agent= 會自動送出 */
function ChatCard({ auto, onAutoSent }: { auto: string; onAutoSent?: () => void }) {
  const hasMsgs = useChat((s) => s.msgs.length > 0);
  return (
    <section className="card" aria-label="AI 對話" style={{ minWidth: 0 }}>
      <div className="hint-head" style={{ marginBottom: 8 }}>
        <div className="row-title"><NewMark since="4.0.0" /> 💬 AI 對話</div>
        <span className="hint-spacer" />
        {hasMsgs && <button className="accent" onClick={() => useChat.getState().clear()}>清除</button>}
      </div>
      <Suspense fallback={<p className="muted">載入中…</p>}><ChatPanel embedded autoSend={auto || undefined} onAutoSent={onAutoSent} /></Suspense>
    </section>
  );
}

export default function AiAssistant() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const ai = useSettings((s) => s.ai);
  const [st, setSt] = useState<AiStatus | null>(null);
  const auto = (params.get('agent') ?? params.get('q') ?? (params.get('tool') === 'budget' ? BUDGET_PROMPT : '') ?? '').slice(0, 300);
  useEffect(() => { if (AUTH_ENABLED && ai?.enabled) getAiStatus().then(setSt).catch(() => undefined); }, [ai?.enabled]);

  const header = (
    <header className="topbar">
      <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
      <h1>AI 助理</h1>
      <button className="icon-btn" aria-label="AI 設定" onClick={() => navigate('/settings/ai')}><Icon name="sliders" /></button>
    </header>
  );
  if (!AUTH_ENABLED) return <main className="page">{header}<p className="muted" style={{ margin: 16 }}>AI 功能需要登入帳號與自架伺服器。</p><SmartAlerts /></main>;
  if (!ai?.enabled) {
    return (
      <main className="page">{header}
        <section className="card" style={{ margin: '12px 0' }}>
          <div className="row-title"><AiMark /> 讓記帳更輕鬆</div>
          <p style={{ whiteSpace: 'normal' }}>用說的整理帳本、問問題、預算建議、拍照記帳。預設關閉，需要先在設定開啟。</p>
          <button className="btn" onClick={() => navigate('/settings/ai')}>前往 AI 設定</button>
        </section>
        <div style={{ display: 'grid', gap: 12 }}>
          <ChatCard auto="" />
          <SmartAlerts />
        </div>
      </main>
    );
  }
  const dataOn = !!ai.allowData;
  return (
    <main className="page">
      {header}
      {st && <p className="row-sub" style={{ margin: '0 4px 8px', whiteSpace: 'normal' }}>{st.available ? '' : '⚠️ '}{st.message}　今日剩 {st.quota.daily.remaining ?? '不限'} 次、本週 {st.quota.weekly.remaining ?? '不限'} 次、本月 {st.quota.monthly.remaining ?? '不限'} 次</p>}
      <div style={{ display: 'grid', gap: 12 }}>
        {/* 自動送出後清掉網址上的 ?q= ?agent=：重新整理或從別頁返回時不會重複送出 */}
        <ChatCard auto={auto} onAutoSent={() => setParams({}, { replace: true })} />
        {!dataOn && (
          <section className="card">
            <p style={{ margin: '0 0 8px', whiteSpace: 'normal' }}>問 AI 與白話解讀需要讓 AI 看你去識別化的收支統計（各月與各分類合計）。</p>
            <button className="btn" onClick={() => navigate('/settings/ai')}>前往允許</button>
          </section>
        )}
        <SmartAlerts />
      </div>
      <p className="set-note">AI 的建議僅供參考，不構成投資或財務專業建議。可到「設定 → AI 設定」查看送出的內容與額度。</p>
    </main>
  );
}
