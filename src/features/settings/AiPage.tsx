/**
 * AI 輔助：一句話／語音記帳規則看不懂時，才請伺服器設定的 AI 解析（預設關閉）。
 * 這頁顯示開關、每日／每週／每月的剩餘額度與下次重置時間。
 */
import { Intro } from '@/ui/Hint';
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
        <h1>Cilo設定</h1>
        <div style={{ width: 44 }} />
      </header>
      <div className="list">
        <SwitchField label="啟用 Cilo" checked={!!ai?.enabled} onChange={(v) => set('ai', { ...ai, enabled: v })}
          sub="對話框的操作助手（整理帳本）、拍照記帳、帳單截圖對帳、一句話記帳看不懂時請 Cilo 解析" />
        <SwitchField label="允許 Cilo 分析我的收支統計" checked={!!ai?.enabled && !!ai?.allowData} onChange={(v) => set('ai', { ...ai, enabled: ai?.enabled || v, allowData: v, auto: v ? ai?.auto : false })}
          sub="用於對話框問 Cilo、操作助手依你的花費規劃預算、報表／專案／帳戶的白話解說" />
        <SwitchField label="首頁自動顯示「上週重點」" checked={!!ai?.enabled && !!ai?.allowData && !!ai?.auto} onChange={(v) => set('ai', { ...ai, enabled: true, allowData: true, auto: v })}
          sub="每週最多自動用 1 點額度；沒開的話只在你按下按鈕時才用 Cilo" />
      </div>
      <div className="list">
        <button className="row" onClick={() => navigate('/settings/ai/sent')}>
          <span className="row-main"><span className="row-title">🔍 查看送出過什麼</span><span className="row-sub" style={{ display: 'block' }}>每一次送去 Cilo 的原文都記在這台裝置，隨時檢查</span></span>
          <Icon name="chevronR" className="row-chev" />
        </button>
      </div>
      <div className="section-title">我的額度</div>
      {err ? <p className="muted" style={{ margin: '0 8px' }}>{err}</p> : !st ? null : (
        <>
          <div className="list">
            <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>{st.available ? '✓ ' : '⚠️ '}{st.message}{st.role === 'admin' ? '　（你是管理員，使用管理員額度）' : ''}</span></div>
            <Bar label="今日" w={st.quota.daily} />
            <Bar label="本週" w={st.quota.weekly} />
            <Bar label="本月" w={st.quota.monthly} />
          </div>
          <Intro id="aipage.4">每日、每週一、每月 1 日 00:00（台北時間）重置；任何一層用完就暫停，不影響其他記帳功能。Cilo 失敗或看不懂不扣額度。額度由管理員設定，使用者與管理員分開計算。</Intro>
        </>
      )}
    </main>
  );
}
