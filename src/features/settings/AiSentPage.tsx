/**
 * AI 送出紀錄：親眼看看每次送去 AI 的內容到底是什麼。
 * 只存在這台裝置（不同步、不上傳）；快取命中沒有真的送出的不會出現在這裡；照片只顯示大小。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AI_FEATURE_LABEL, clearAiLog, loadAiLog } from '@/services/aiLog';
import { Icon } from '@/ui/Icon';
import { EmptyState } from '@/ui/controls';

export default function AiSentPage() {
  const navigate = useNavigate();
  const log = useLiveQuery(() => loadAiLog(), []);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>AI 送出紀錄</h1>
        <div style={{ width: 44 }} />
      </header>
      <p className="muted" style={{ fontSize: '0.85rem', margin: '0 4px 12px' }}>
        這裡是這台裝置上，每一次真的送去 AI 的內容（原文）。只存在這台裝置、不會同步或上傳，最多保留最近 25 筆。
        命中快取（沒有真的送出）的查詢不會出現；照片只顯示大小，不留存影像。
      </p>
      {!log ? null : log.length === 0 ? (
        <EmptyState emoji="🔒" title="還沒有送出過任何內容" text="使用 AI 功能時，送出的內容會記在這裡。" />
      ) : (
        <>
          <div className="list">
            {log.map((r, i) => (
              <div key={r.at} className="row" style={{ display: 'block' }}>
                <button style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, textAlign: 'left' }} onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                  <span className="row-main">
                    <span className="row-title">{AI_FEATURE_LABEL[r.path] ?? r.path}</span>
                    <span className="row-sub" style={{ display: 'block' }}>{new Date(r.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}・{(r.bytes / 1024).toFixed(1)} KB</span>
                  </span>
                  <Icon name={open === i ? 'up' : 'chevronD'} size={16} />
                </button>
                {open === i && (
                  <pre className="ai-sent-pre" tabIndex={0}>{r.payload}{r.truncated ? '\n…（內容過長，這裡只顯示前 20,000 字元）' : ''}</pre>
                )}
              </div>
            ))}
          </div>
          <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => { if (window.confirm('清除所有送出紀錄？（只影響這份檢視，不影響 AI 功能）')) void clearAiLog(); }}>清除紀錄</button>
        </>
      )}
    </main>
  );
}
