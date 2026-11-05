/**
 * 操作助手卡片（/ai 頁最上面）：用一句話整理帳本。
 * 流程：說需求 → AI 規劃步驟（1 點額度，AI 只規劃不執行）→ 本機「執行預覽」（影響筆數、預算變化、帳戶餘額）→
 * 你確認才執行 → 隨時「一鍵還原」（7 天內）。
 */
import { useEffect, useRef, useState } from 'react';
import { applyPlan, listAgentOps, previewPlan, undoOp, type AgentOpLog } from '@/services/agent';
import { aiAgentPlan, quotaLabel } from '@/services/ai';
import { summarizePlan, type ResolvedStep } from '@/domain/agent/plan';
import { formatMoney } from '@/domain/money';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { NewMark } from '@/ui/NewMark';
import { Hint } from '@/ui/Hint';

const EXAMPLES = [
  '把上個月所有 Uber 跟台灣大車隊都歸到「交通」，並設交通每月預算 3000，超過 80% 提醒我',
  '幫我建立每月 12 號 Netflix 390 元的訂閱',
  '如果我一次還房貸 20 萬，可以省多少利息？',
];

const when = (t: number) => new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function AgentCard({ initialText = '' }: { initialText?: string }) {
  const base = useSettings((s) => s.baseCurrency);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [plan, setPlan] = useState<{ summary: string; steps: ResolvedStep[]; quota: string } | null>(null);
  const [done, setDone] = useState<AgentOpLog | null>(null);
  const [history, setHistory] = useState<AgentOpLog[]>([]);
  const started = useRef(false);

  const reload = () => { void listAgentOps().then(setHistory); };
  useEffect(reload, []);

  const run = async (input: string) => {
    const t = input.trim();
    if (!t || busy) return;
    setBusy(true); setErr(''); setPlan(null); setDone(null);
    try {
      const r = await aiAgentPlan(t);
      const steps = await previewPlan(r.plan.steps);
      setPlan({ summary: r.plan.summary, steps, quota: quotaLabel(r.quota) });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (initialText && !started.current) { started.current = true; void run(initialText); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const diff = plan ? summarizePlan(plan.steps) : null;

  const execute = async () => {
    if (!plan || !diff?.executable || busy) return;
    setBusy(true); setErr('');
    try {
      const log = await applyPlan(plan.steps, plan.summary);
      setDone(log); setPlan(null); setText(''); reload();
      snackUndo(`已執行 ${log.titles.length} 項操作`, async () => { await undoOp(log.id); setDone(null); reload(); });
    } catch (e) { setErr(`執行失敗，沒有任何資料被改動：${(e as Error).message}`); } finally { setBusy(false); }
  };

  const undo = async (id: string) => {
    try {
      const r = await undoOp(id);
      useUI.getState().showSnack({ text: r.skipped ? `已還原 ${r.restored} 筆；${r.skipped} 筆在執行後又被你改過，沒有動它` : `已還原 ${r.restored} 筆` });
      if (done?.id === id) setDone(null);
    } catch (e) { useUI.getState().showSnack({ text: (e as Error).message }); }
    reload();
  };

  return (
    <section className="card" aria-label="操作助手" style={{ minWidth: 0 }}>
      <Hint id="ai.agent" title={<><NewMark since="4.0.0" /> 🧰 用說的整理帳本</>}
        hint="說出你想做的事，AI 只負責規劃；你會先看到「執行預覽」（影響幾筆、預算怎麼變、帳戶餘額），確認才會執行，之後還能一鍵還原。只會送出這句話與分類、帳戶的名稱（1 點額度）。" />

      <form style={{ display: 'grid', gap: 8, marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void run(text); }}>
        <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={300} aria-label="想做的事"
          placeholder="例如：把上個月所有 Uber 都改歸類到「交通」，並設每月預算 3000" style={{ resize: 'vertical', padding: '13px 14px', lineHeight: 1.5, minHeight: 76 }} />
        <button className="btn" type="submit" disabled={busy || !text.trim()}>{busy && !plan ? '規劃中…' : '產生執行預覽'}</button>
      </form>
      {!plan && !done && !busy && (
        <div className="ask-examples" style={{ marginTop: 8 }}>
          {EXAMPLES.map((x) => <button key={x} className="pill" onClick={() => setText(x)}>{x.length > 26 ? `${x.slice(0, 26)}…` : x}</button>)}
        </div>
      )}
      {err && <p className="row-sub" role="alert" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{err}</p>}

      {plan && diff && (
        <div className="agent-preview" aria-live="polite">
          <div className="row-title" style={{ marginTop: 14, whiteSpace: 'normal' }}>執行預覽{plan.summary ? `：${plan.summary}` : ''}</div>
          <div className="agent-diff">
            {diff.affectedTx > 0 && <span className="pill">影響 {diff.affectedTx} 筆帳目</span>}
            {diff.budgetChanges > 0 && <span className="pill">預算 {diff.budgetChanges} 項</span>}
            {diff.rulesCreated > 0 && <span className="pill">新增週期 {diff.rulesCreated} 條</span>}
            <span className="pill">帳戶餘額不變</span>
          </div>
          {plan.steps.map((s, i) => (
            <div key={i} className={`agent-step${s.preview.blocked ? ' blocked' : ''}`}>
              <div className="agent-step-title">
                <span className="agent-n">{i + 1}</span>{s.preview.blocked ? `${s.preview.title}（不會執行）` : s.preview.title}
                {s.preview.readonly && !s.preview.blocked && <span className="agent-tag">僅試算</span>}
              </div>
              {s.preview.blocked ? <p className="row-sub" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{s.preview.blocked}</p> : (
                <>
                  <ul className="agent-lines">{s.preview.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>
                  {s.preview.samples && (
                    <details className="agent-samples">
                      <summary>抽樣看 {s.preview.samples.length} 筆（核對有沒有誤傷）</summary>
                      {s.preview.samples.map((x, j) => (
                        <div key={j} className="agent-sample"><span>{x.date.slice(5)}　{x.note}</span><span className="num">{formatMoney(x.amountMinor, base, { decimals: 0 })}　<i>{x.from}</i></span></div>
                      ))}
                    </details>
                  )}
                  {s.preview.warnings.map((w, j) => <p key={j} className="row-sub" style={{ color: 'var(--warning)', whiteSpace: 'normal' }}>⚠️ {w}</p>)}
                </>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn secondary" style={{ flex: 1 }} onClick={() => setPlan(null)} disabled={busy}>取消</button>
            <button className="btn" style={{ flex: 2 }} onClick={() => void execute()} disabled={busy || !diff.executable}>
              {diff.executable ? `確認執行（${diff.executable} 項）` : diff.readonly ? '這是試算，不需要執行' : '沒有可以執行的步驟'}
            </button>
          </div>
          <p className="row-sub" style={{ whiteSpace: 'normal' }}>{plan.quota}　執行是「全部成功或全部不動」，之後 7 天內可一鍵還原。</p>
        </div>
      )}

      {done && (
        <div className="agent-done" role="status">
          <div className="row-title" style={{ whiteSpace: 'normal' }}>✅ 已執行 {done.titles.length} 項操作</div>
          <ul className="agent-lines">{done.titles.map((t, i) => <li key={i}>{t}</li>)}</ul>
          <button className="btn small tinted" onClick={() => void undo(done.id)}>一鍵還原</button>
        </div>
      )}

      {history.length > 0 && (
        <details className="agent-history">
          <summary>最近的操作（{history.length}）</summary>
          {history.map((h) => (
            <div key={h.id} className="row" style={{ gap: 8 }}>
              <span className="row-main">
                <span className="row-title">{h.summary}</span>
                <span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>{when(h.at)}　{h.titles.join('；')}</span>
              </span>
              {h.undoneAt ? <span className="muted">已還原</span> : <button className="btn small tinted" onClick={() => void undo(h.id)}>還原</button>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
