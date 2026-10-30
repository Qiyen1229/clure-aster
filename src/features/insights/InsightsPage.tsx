/**
 * 異常與訂閱偵測、預算預警（/insights）。
 * 全部在這台裝置用規則運算：不使用 AI、不呼叫伺服器、不計入 AI 額度。
 * 「重新偵測」與「白話說明」5 分鐘內最多 10 次（避免連點）；自動偵測在開啟 App 時於閒置時間執行。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Finding } from '@/domain/anomaly';
import type { BudgetWarning } from '@/domain/budgetwarn';
import { createSubscriptionFrom, dismissFinding, loadSnapshot, runInsights, type InsightsSnapshot } from '@/services/insights';
import { consume, remaining } from '@/services/usageLimit';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { WhyToggle } from './WhyToggle';

const KIND_ICON: Record<Finding['kind'], string> = { subscription: '🔁', price_up: '📈', duplicate: '🧾', large: '💥', surge: '📊' };
const KIND_LABEL: Record<Finding['kind'], string> = { subscription: '新發現的訂閱', price_up: '漲價', duplicate: '疑似重複', large: '異常大額', surge: '分類暴增' };
const LEVEL_COLOR = { over: 'var(--danger)', critical: 'var(--warning)', early: 'var(--accent-text)' } as const;

export default function InsightsPage() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.insights);
  const snap = useLiveQuery(() => loadSnapshot(), [], undefined as InsightsSnapshot | null | undefined);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(() => remaining('insight-anomaly'));
  const [note, setNote] = useState('');
  const on = cfg.anomaly || cfg.budgetWarn;

  // 進來時用（新的）快取；過期才重算，不計入使用次數
  useEffect(() => { if (on) void runInsights(); }, [on, cfg.anomaly, cfg.budgetWarn]);

  const refresh = async () => {
    const r = consume('insight-anomaly');
    setLeft(remaining('insight-anomaly'));
    if (!r.ok) { setNote(r.message); return; }
    setNote('');
    setBusy(true);
    try { await runInsights({ force: true }); } finally { setBusy(false); }
  };

  const findings = snap?.findings ?? [];
  const warnings = snap?.warnings ?? [];
  const warnList = findings.filter((f) => f.severity === 'warn');
  const infoList = findings.filter((f) => f.severity === 'info');

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>異常與訂閱偵測</h1>
        <div style={{ width: 44 }} />
      </header>

      {!on ? (
        <EmptyState emoji="🔕" title="偵測已關閉" text="到「設定 → 智慧提醒」開啟異常與訂閱偵測、預算預警。"
          action={<button className="btn small" onClick={() => navigate('/settings')}>前往設定</button>} />
      ) : (
        <>
          <p className="muted" style={{ fontSize: '0.85rem', margin: '0 4px 12px' }}>
            全部在這台裝置上用規則運算，<b>不使用 AI、不計入 AI 額度</b>。「重新偵測」與「白話說明」5 分鐘內最多 10 次。
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
            <button className="btn small" disabled={busy} onClick={() => void refresh()}>{busy ? '偵測中…' : '重新偵測'}</button>
            <span className="muted" style={{ fontSize: '0.8rem' }}>{snap ? `上次偵測 ${new Date(snap.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` : ''}　剩 {left} 次</span>
          </div>
          {note && <p className="insight-limit" role="status">{note}</p>}

          {snap === undefined ? <SkeletonRows /> : (
            <>
              {cfg.budgetWarn && (
                <>
                  <div className="section-title">預算預警</div>
                  {warnings.length === 0 ? <p className="muted" style={{ margin: '0 8px 12px' }}>目前所有預算的花費速度都在額度內 ✓</p> : (
                    warnings.map((w) => <WarningCard key={w.id} w={w} onOpen={() => navigate('/plan?tab=budget')} />)
                  )}
                </>
              )}
              {cfg.anomaly && (
                <>
                  <div className="section-title">需要留意</div>
                  {warnList.length === 0 ? <p className="muted" style={{ margin: '0 8px 12px' }}>沒有發現異常 ✓</p> : warnList.map((f) => <FindingCard key={f.id} f={f} onChange={() => setLeft(remaining('insight-anomaly'))} />)}
                  {infoList.length > 0 && <div className="section-title">其他發現</div>}
                  {infoList.map((f) => <FindingCard key={f.id} f={f} onChange={() => setLeft(remaining('insight-anomaly'))} />)}
                </>
              )}
              <p className="muted" style={{ fontSize: '0.75rem', margin: '16px 8px' }}>
                偵測依據：最近 14 個月的帳目。資料太少或金額太小時不會判斷，以免誤報。按「略過」後這一項不再提醒（會同步到你的其他裝置）。
              </p>
            </>
          )}
        </>
      )}
    </main>
  );
}

function WarningCard({ w, onOpen }: { w: BudgetWarning; onOpen: () => void }) {
  return (
    <section className="card insight-card" style={{ ['--lv' as string]: LEVEL_COLOR[w.level] }}>
      <div className="insight-head">
        <span aria-hidden="true">{w.level === 'over' ? '⚠️' : '🔔'}</span>
        <div className="row-main"><div className="insight-title">{w.title}</div></div>
      </div>
      <WhyToggle id={w.id} limitKey="insight-budget" why={w.why} tip={w.tip} />
      <div className="insight-actions"><button className="accent" onClick={onOpen}>查看預算</button></div>
    </section>
  );
}

function FindingCard({ f, onChange }: { f: Finding; onChange: () => void }) {
  const navigate = useNavigate();
  const snack = (text: string) => useUI.getState().showSnack({ text });
  const [busy, setBusy] = useState(false);
  return (
    <section className="card insight-card" style={{ ['--lv' as string]: f.severity === 'warn' ? 'var(--warning)' : 'var(--accent-text)' }}>
      <div className="insight-head">
        <span aria-hidden="true">{KIND_ICON[f.kind]}</span>
        <div className="row-main">
          <div className="insight-title">{f.title}</div>
          <div className="row-sub">{KIND_LABEL[f.kind]}　{f.date.slice(5).replace('-', '/')}</div>
        </div>
      </div>
      <div onClick={onChange}><WhyToggle id={f.id} limitKey="insight-anomaly" why={f.why} tip={f.tip} /></div>
      <div className="insight-actions">
        {f.subscription && (
          <button className="accent" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await createSubscriptionFrom(f); snack(`已登記「${f.subscription!.name}」（每期到了提醒你確認）`); }
            catch (e) { snack((e as Error).message); } finally { setBusy(false); }
          }}>{f.subscription.kind === 'subscription' ? '建立為訂閱' : '登記為週期帳目'}</button>
        )}
        {f.txIds.length > 0 && <button className="accent" onClick={() => useUI.getState().editTx(f.txIds[f.txIds.length - 1])}>查看帳目</button>}
        {f.kind === 'surge' && <button className="accent" onClick={() => navigate('/reports')}>看報表</button>}
        <button className="muted" onClick={() => {
          void dismissFinding(f.id);
          snackUndo('已略過，之後不再提醒這一項', async () => {
            const s = useSettings.getState();
            s.set('insights', { ...s.insights, dismissed: s.insights.dismissed.filter((x) => x !== f.id) });
            await runInsights({ force: true });
          });
        }}>略過</button>
      </div>
    </section>
  );
}
