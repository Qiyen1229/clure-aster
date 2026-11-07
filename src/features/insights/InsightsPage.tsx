/**
 * 異常與訂閱偵測、預算預警的結果清單（顯示在 AI 助理頁的「智慧提醒」裡；舊網址 /insights 會轉到 /ai）。
 * 平常全部在這台裝置用規則運算（不呼叫伺服器、不計入 AI 額度）；只有規則判斷不了的新支出，才（在使用者開啟 AI 的前提下）請 AI 查市價。
 * 沒有手動「重新偵測」：系統在每新增一筆支出、以及開啟 App 時自動偵測；白話說明可以無限次展開。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Finding } from '@/domain/anomaly';
import type { BudgetWarning } from '@/domain/budgetwarn';
import { createSubscriptionFrom, dismissFinding, loadSnapshot, runInsights, type InsightsSnapshot } from '@/services/insights';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { SkeletonRows } from '@/ui/controls';
import { WhyToggle } from './WhyToggle';

const KIND_ICON: Record<Finding['kind'], string> = { subscription: '🔁', price_up: '📈', duplicate: '🧾', large: '💥', surge: '📊' };
const KIND_LABEL: Record<Finding['kind'], string> = { subscription: '新發現的訂閱', price_up: '漲價', duplicate: '疑似重複', large: '異常大額', surge: '分類暴增' };
const LEVEL_COLOR = { over: 'var(--danger)', critical: 'var(--warning)', early: 'var(--accent-text)' } as const;

export function InsightsResults() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.insights);
  const snap = useLiveQuery(() => loadSnapshot(), [], undefined as InsightsSnapshot | null | undefined);
  const on = cfg.anomaly || cfg.budgetWarn;

  // 進來時用（新的）快取；過期才重算
  useEffect(() => { if (on) void runInsights(); }, [on, cfg.anomaly, cfg.budgetWarn]);
  if (!on) return null;

  const findings = snap?.findings ?? [];
  const warnings = snap?.warnings ?? [];
  const warnList = findings.filter((f) => f.severity === 'warn');
  const infoList = findings.filter((f) => f.severity === 'info');

  return (
    <div style={{ marginTop: 8 }}>
      {snap === undefined ? <SkeletonRows /> : (
        <>
          {snap && <p className="muted" style={{ fontSize: '0.8rem', margin: '0 4px 8px' }}>目前的偵測結果（上次偵測 {new Date(snap.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）</p>}
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
              {warnList.length === 0 ? <p className="muted" style={{ margin: '0 8px 12px' }}>沒有發現異常 ✓</p> : warnList.map((f) => <FindingCard key={f.id} f={f} />)}
              {infoList.length > 0 && <div className="section-title">其他發現</div>}
              {infoList.map((f) => <FindingCard key={f.id} f={f} />)}
            </>
          )}
          <p className="muted" style={{ fontSize: '0.75rem', margin: '12px 8px 0' }}>
            依據最近 14 個月的帳目；資料太少或金額太小不判斷，以免誤報。按「略過」後不再提醒（會同步到其他裝置）。
          </p>
        </>
      )}
    </div>
  );
}

function WarningCard({ w, onOpen }: { w: BudgetWarning; onOpen: () => void }) {
  return (
    <section className="card insight-card" style={{ ['--lv' as string]: LEVEL_COLOR[w.level] }}>
      <div className="insight-head">
        <span aria-hidden="true">{w.level === 'over' ? '⚠️' : '🔔'}</span>
        <div className="row-main"><div className="insight-title">{w.title}</div></div>
      </div>
      <WhyToggle id={w.id} why={w.why} tip={w.tip} />
      <div className="insight-actions"><button className="accent" onClick={onOpen}>查看預算</button></div>
    </section>
  );
}

function FindingCard({ f }: { f: Finding }) {
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
      <WhyToggle id={f.id} why={f.why} tip={f.tip} />
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
