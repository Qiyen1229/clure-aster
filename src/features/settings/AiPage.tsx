/**
 * AI 輔助：一句話／語音記帳規則看不懂時，才請伺服器設定的 AI 解析（預設關閉）。
 * 這頁顯示開關、每日／每週／每月的剩餘額度與下次重置時間。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAiStatus, type AiQuotaWindow, type AiStatus } from '@/services/ai';
import { useSettings } from '@/stores/settings';
import { SwitchField } from '@/ui/form';
import { Icon } from '@/ui/Icon';

const resetText = (iso: string) => new Date(iso + 'Z').toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function Bar({ label, w }: { label: string; w: AiQuotaWindow }) {
  const pct = w.limit ? Math.min(100, Math.round((w.used / w.limit) * 100)) : 0;
  return (
    <div className="row" style={{ display: 'block' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="row-title">{label}</span>
        <span className="num">{w.limit ? `${w.used} / ${w.limit}` : `${w.used}（不限）`}</span>
      </div>
      {!!w.limit && (
        <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 6, borderRadius: 3, background: 'var(--fill, rgba(127,127,127,.2))', margin: '6px 0', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct >= 100 ? 'var(--danger)' : 'var(--accent)' }} />
        </div>
      )}
      <div className="row-sub">{w.limit ? `剩 ${w.remaining} 次，` : ''}{resetText(w.resets_at)} 重置</div>
    </div>
  );
}

export default function AiPage() {
  const navigate = useNavigate();
  const ai = useSettings((s) => s.ai);
  const set = useSettings((s) => s.set);
  const [st, setSt] = useState<AiStatus | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { getAiStatus().then(setSt).catch((e: Error) => setErr(e.message)); }, [ai?.enabled]);

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>AI 設定</h1>
        <div style={{ width: 44 }} />
      </header>
      <div className="list">
        <SwitchField label="啟用 AI 功能" checked={!!ai?.enabled} onChange={(v) => set('ai', { ...ai, enabled: v })}
          sub="一句話記帳看不懂時請 AI 解析、拍照記帳、AI 整理分類" />
        <SwitchField label="允許 AI 分析我的收支統計" checked={!!ai?.enabled && !!ai?.allowData} onChange={(v) => set('ai', { ...ai, enabled: ai?.enabled || v, allowData: v })}
          sub="用於「問 AI」、下月預算建議、週報月報白話解讀" />
      </div>
      <p className="set-note">
        <b>一句話記帳／整理分類／拍照記帳</b>：送出你輸入的那一句話（整理分類是帳目備註、拍照記帳是縮小後的收據照片），以及你的分類與帳戶「名稱」。
        一句話記帳只有規則解析找不到金額時才會用到，輸入過程中的即時預覽不會用到額度。
      </p>
      <p className="set-note">
        <b>收支統計</b>（需另外允許）：最近約 6 個月每月的收入、支出與各分類合計、每月固定支出（訂閱／分期／貸款）、各預算的上限與已花、存錢目標進度與淨資產，全部是整數統計。
        <b>不會送出</b>：單筆帳目、備註、商家、日期明細、帳戶名稱、標籤。
      </p>
      <p className="set-note">
        送出的內容會經過你的伺服器與管理員設定的第三方 AI 供應商，不在端對端加密的範圍內。免費方案的供應商可能把內容用於改進產品（例如 Google Gemini 免費層），請不要在輸入裡寫入敏感資料。
        相同內容的結果會暫存在這台裝置，重複查詢不會再扣額度。
      </p>
      <div className="section-title">我的額度</div>
      {err ? <p className="muted" style={{ margin: '0 8px' }}>{err}</p> : !st ? null : (
        <>
          <div className="list">
            <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>{st.available ? '✓ ' : '⚠️ '}{st.message}</span></div>
            <Bar label="今日" w={st.quota.daily} />
            <Bar label="本週" w={st.quota.weekly} />
            <Bar label="本月" w={st.quota.monthly} />
          </div>
          <p className="set-note">每日 00:00、每週一 00:00、每月 1 日 00:00（台北時間）重置；任何一層用完就暫停，其他記帳功能不受影響。AI 失敗或看不懂時不扣額度。額度由管理員設定。</p>
        </>
      )}
    </main>
  );
}
