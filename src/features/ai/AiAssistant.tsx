/**
 * AI 助理（/ai）：把 AI 放進記帳的各個環節。
 *  - 問 AI：依去識別化的收支統計回答（不是規則式的「用問的查帳」）
 *  - 下個月預算建議：總預算、各分類、日常預算額度，可一鍵建立為每月預算
 *  - 本月／上月白話解讀
 *  - AI 整理分類：把「其他」分類裡的帳目依備註建議分類，勾選後套用（可復原）
 *  - 拍照記帳：辨識收據照片
 *  - AI 對話：記帳、查帳、問 AI、用說的整理帳本共用同一個輸入框（features/home/AiChat.tsx 的 ChatPanel，與首頁小圓球同一份對話）
 * 所有 AI 輸出都只當純文字顯示。網址參數：?q=問題（自動詢問）、?tool=budget（直接產生預算建議）、?agent=需求（自動規劃操作）
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAccounts, useCategories } from '@/app/hooks';
import { db } from '@/db/schema';
import { batchUpdate } from '@/db/repo/ledger';
import { createBudgetsFromPlan, deleteBudget } from '@/db/repo/plan';
import { planToBudgetInputs } from '@/domain/aisummary';
import { formatMoney } from '@/domain/money';
import { addDays, todayKey } from '@/domain/period';
import { AUTH_ENABLED } from '@/stores/auth';
import { aiBudgetPlan, aiCategorize, aiReceipt, getAiStatus, quotaLabel, type AiStatus, type PlanResult } from '@/services/ai';
import { bookDrafts, fallbackAccount, resolveDraft, type ResolvedDraft } from '@/services/quickentry';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { AiMark, Icon } from '@/ui/Icon';
import { Switch } from '@/ui/controls';
import { Hint } from '@/ui/Hint';
import { AiInsightsCard } from './AiInsights';
import { lastCompleted } from '@/services/summary';
import { SmartAlerts } from './SmartAlerts';
import { NewMark } from '@/ui/NewMark';
import { useChat } from '@/features/home/aiChatStore';

const ChatPanel = lazy(() => import('@/features/home/AiChat').then((m) => ({ default: m.ChatPanel })));

const Err = ({ text }: { text: string }) => (text ? <p className="row-sub" role="alert" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{text}</p> : null);

// ───────────── 下個月預算建議 ─────────────

function BudgetCard({ auto }: { auto: boolean }) {
  const [res, setRes] = useState<{ plan: PlanResult; cached: boolean; quota?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const started = useRef(false);

  const run = async (force = false) => {
    setBusy(true); setErr('');
    try {
      const r = await aiBudgetPlan(force);
      setRes({ plan: r.value, cached: r.cached, quota: r.quota ? quotaLabel(r.quota) : undefined });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (auto && !started.current) { started.current = true; void run(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    if (!res) return;
    const { plan } = res;
    const [cats, budgets] = await Promise.all([db.categories.toArray(), db.budgets.toArray()]);
    const { items, skipped } = planToBudgetInputs(plan, cats, budgets, plan.decimals);
    if (!items.length) { useUI.getState().showSnack({ text: '這些預算都已經有了，不需要重複建立' }); return; }
    const ids = await createBudgetsFromPlan(items, plan.currency);
    snackUndo(`已建立 ${ids.length} 個每月預算${skipped.length ? `（略過已有的：${skipped.join('、')}）` : ''}`, async () => { for (const id of ids) await deleteBudget(id); });
  };

  const p = res?.plan;
  const money = (v: number) => (p ? formatMoney(Math.round(v * 10 ** p.decimals), p.currency, { decimals: 0 }) : String(v));
  return (
    <section className="card" aria-label="下個月預算建議" aria-live="polite">
      <Hint id="ai.budget" title="📅 下個月預算建議"
        right={<button className="btn small" disabled={busy} onClick={() => void run(!!res)}>{busy ? '分析中…' : res ? '重新產生' : '產生建議'}</button>} />
      <Err text={err} />
      {p && (
        <div style={{ marginTop: 10 }}>
          <div className="admin-grid">
            <div className="admin-stat"><div className="k">{p.label} 建議總預算</div><div className="v num">{money(p.total)}</div></div>
            <div className="admin-stat"><div className="k">每月固定支出</div><div className="v num">{money(p.fixedTotal)}</div></div>
            <div className="admin-stat"><div className="k">日常預算／天（{p.days} 天）</div><div className="v num">{money(p.daily)}</div></div>
          </div>
          <p className="row-sub" style={{ whiteSpace: 'normal' }}>日常預算 =（總預算 − 固定支出）÷ {p.days} 天</p>
          <div className="list">
            {p.categories.map((c) => (
              <div key={c.name} className="row" style={{ display: 'block' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="row-title">{c.name}</span><span className="num">{money(c.amount)}</span></div>
                {c.reason && <div className="row-sub" style={{ whiteSpace: 'normal' }}>{c.reason}</div>}
              </div>
            ))}
          </div>
          {!!p.tips.length && <ul style={{ margin: '8px 0 4px 18px', padding: 0 }}>{p.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>}
          {p.assumption && <p className="row-sub" style={{ whiteSpace: 'normal' }}>依據：{p.assumption}</p>}
          <button className="btn" style={{ marginTop: 8 }} onClick={() => void apply()}>套用為每月預算</button>
          <p className="row-sub" style={{ whiteSpace: 'normal' }}>{res.cached ? '使用先前的結果（未扣額度）' : res.quota}　僅供參考；已有的預算不會被覆蓋。</p>
        </div>
      )}
    </section>
  );
}

// ───────────── AI 整理分類 ─────────────

interface Group { key: string; note: string; ids: string[]; prev: Map<string, string[]>; catId: string; on: boolean }

function CategorizeCard() {
  const cats = useCategories();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const choices = useMemo(() => cats.all.filter((c) => c.kind === 'expense' && !c.archived && !c.system && !c.name.includes('其他')), [cats.all]);
  const byName = useMemo(() => new Map(choices.map((c) => [c.name, c.id])), [choices]);

  const scan = async () => {
    setBusy(true); setErr(''); setMsg(''); setGroups(null);
    try {
      const others = new Set(cats.all.filter((c) => c.kind === 'expense' && c.name.includes('其他')).map((c) => c.id));
      const from = addDays(todayKey(), -365);
      const txs = (await db.transactions.where('date').aboveOrEqual(from).toArray()).filter((t) => !t.deletedAt && t.type === 'expense' && !t.transferId && others.has(t.categoryId) && !!t.note.trim());
      const map = new Map<string, Group>();
      for (const t of txs) {
        const key = t.note.trim().toLowerCase();
        const g: Group = map.get(key) ?? { key, note: t.note.trim(), ids: [], prev: new Map<string, string[]>(), catId: '', on: false };
        g.ids.push(t.id);
        g.prev.set(t.categoryId, [...(g.prev.get(t.categoryId) ?? []), t.id]);
        map.set(key, g);
      }
      const list = [...map.values()].sort((a, b) => b.ids.length - a.ids.length).slice(0, 40);
      if (!list.length) { setMsg('「其他」分類裡沒有需要整理的帳目 🎉'); setGroups([]); return; }
      const r = await aiCategorize(list.map((g) => g.note), choices.map((c) => c.name));
      for (const it of r.items) { const id = byName.get(it.category); if (id && list[it.index]) { list[it.index].catId = id; list[it.index].on = true; } }
      setGroups(list);
      setMsg(`${quotaLabel(r.quota)}。請檢查建議，沒問題的勾選後套用。`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const chosen = (groups ?? []).filter((g) => g.on && g.catId);
  const apply = async () => {
    const undo: { ids: string[]; categoryId: string }[] = [];
    let n = 0;
    for (const g of chosen) {
      await batchUpdate(g.ids, { categoryId: g.catId });
      n += g.ids.length;
      for (const [cat, ids] of g.prev) undo.push({ ids, categoryId: cat });
    }
    setGroups((gs) => (gs ?? []).filter((g) => !chosen.includes(g)));
    snackUndo(`已整理 ${n} 筆帳目的分類`, async () => { for (const u of undo) await batchUpdate(u.ids, { categoryId: u.categoryId }); });
  };
  const patch = (key: string, p: Partial<Group>) => setGroups((gs) => (gs ?? []).map((g) => (g.key === key ? { ...g, ...p } : g)));

  return (
    <section className="card" aria-label="AI 整理分類">
      <Hint id="ai.categorize" title="🗂 AI 整理分類" hint="找出近一年歸在「其他」的帳目，依備註建議分類。備註文字會送給 AI（一次 1 點額度、最多 40 種備註）。"
        right={<button className="btn small" disabled={busy} onClick={() => void scan()}>{busy ? '分析中…' : '掃描「其他」'}</button>} />
      <Err text={err} />
      {msg && <p className="row-sub" style={{ whiteSpace: 'normal' }}>{msg}</p>}
      {!!groups?.length && (
        <>
          <div className="list" style={{ marginTop: 8 }}>
            {groups.map((g) => (
              <div key={g.key} className="row" style={{ gap: 8 }}>
                <Switch label={`套用 ${g.note}`} checked={g.on && !!g.catId} disabled={!g.catId} onChange={(v) => patch(g.key, { on: v })} />
                <span className="row-main"><span className="row-title">{g.note}</span><span className="row-sub" style={{ display: 'block' }}>{g.ids.length} 筆</span></span>
                <select className="mini-select" aria-label={`${g.note} 的分類`} value={g.catId} onChange={(e) => patch(g.key, { catId: e.target.value, on: !!e.target.value })}>
                  <option value="">不變</option>
                  {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          <button className="btn" style={{ marginTop: 8 }} disabled={!chosen.length} onClick={() => void apply()}>套用 {chosen.reduce((a, g) => a + g.ids.length, 0)} 筆</button>
        </>
      )}
    </section>
  );
}

// ───────────── 拍照記帳 ─────────────

function ReceiptCard() {
  const accounts = useAccounts(true);
  const cats = useCategories();
  const [drafts, setDrafts] = useState<ResolvedDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [quota, setQuota] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true); setErr(''); setDrafts([]);
    try {
      const r = await aiReceipt(file);
      const fb = await fallbackAccount();
      setDrafts(await Promise.all(r.drafts.map((d) => resolveDraft(d, fb))));
      setQuota(quotaLabel(r.quota));
      if (!r.drafts.length) setErr('看不出這張照片的消費金額，請拍清楚一點或改用手動記帳');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const toAdd = (d: ResolvedDraft) => {
    useUI.getState().openAdd({ mode: 'expense', amount: String(d.amount), note: d.note, categoryId: d.categoryId, accountId: d.accountId, date: d.date });
  };
  const book = async () => {
    const r = await bookDrafts(drafts);
    setDrafts([]);
    snackUndo(`已記下 ${drafts.length} 筆`, async () => {
      const { deleteTransactions } = await import('@/db/repo/ledger');
      await deleteTransactions(r.txIds);
    });
  };
  return (
    <section className="card" aria-label="拍照記帳">
      <Hint id="ai.receipt" title="📷 拍照記帳" hint="拍下收據或發票，AI 辨識金額、店名與日期（一次 2 點額度）。照片縮小後送出，不會保存在伺服器。"
        right={<button className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? '辨識中…' : '拍照／選擇收據'}</button>} />
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      <Err text={err} />
      {drafts.map((d, i) => (
        <div key={i} className="row" style={{ marginTop: 8, gap: 8 }}>
          <span className="row-main">
            <span className="row-title num">{formatMoney(Math.round(d.amount * 100), useSettings.getState().baseCurrency, { decimals: 0 })}　{d.note || '（無備註）'}</span>
            <span className="row-sub" style={{ display: 'block' }}>{cats.map.get(d.categoryId ?? '')?.name ?? '其他'}　{accounts.map.get(d.accountId)?.name ?? ''}　{d.date}</span>
          </span>
          <button className="btn small tinted" onClick={() => toAdd(d)}>帶入記帳面板</button>
        </div>
      ))}
      {drafts.length > 0 && <><button className="btn" style={{ marginTop: 8 }} onClick={() => void book()}>直接記帳（{drafts.length} 筆）</button><p className="row-sub">{quota}　AI 可能看錯，建議先「帶入記帳面板」確認金額。</p></>}
    </section>
  );
}

// ───────────── 頁面 ─────────────

/** AI 對話：記帳、查帳、問 AI、用說的整理帳本全部在同一個輸入框（和首頁 AI 小圓球的對話是同一份）；?q= 或 ?agent= 會自動送出 */
function ChatCard({ auto }: { auto: string }) {
  const hasMsgs = useChat((s) => s.msgs.length > 0);
  return (
    <section className="card" aria-label="AI 對話" style={{ minWidth: 0 }}>
      <div className="hint-head" style={{ marginBottom: 8 }}>
        <div className="row-title"><NewMark since="4.0.0" /> 💬 AI 對話</div>
        <span className="hint-spacer" />
        {hasMsgs && <button className="accent" onClick={() => useChat.getState().clear()}>清除</button>}
      </div>
      <Suspense fallback={<p className="muted">載入中…</p>}><ChatPanel embedded autoSend={auto || undefined} /></Suspense>
    </section>
  );
}

export default function AiAssistant() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const ai = useSettings((s) => s.ai);
  const [st, setSt] = useState<AiStatus | null>(null);
  const auto = (params.get('agent') ?? params.get('q') ?? '').slice(0, 300);
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
        <ChatCard auto={auto} />
        {dataOn ? (
          <>
            <BudgetCard auto={params.get('tool') === 'budget'} />
            <div><AiInsightsCard unit="month" anchor={lastCompleted('month')} /></div>
          </>
        ) : (
          <section className="card">
            <p style={{ margin: '0 0 8px', whiteSpace: 'normal' }}>預算建議、白話解讀與問 AI 需要讓 AI 看你去識別化的收支統計（各月與各分類合計）。</p>
            <button className="btn" onClick={() => navigate('/settings/ai')}>前往允許</button>
          </section>
        )}
        <CategorizeCard />
        <ReceiptCard />
        <SmartAlerts />
      </div>
      <p className="set-note">AI 的建議僅供參考，不構成投資或財務專業建議。可到「設定 → AI 設定」查看送出的內容與額度。</p>
    </main>
  );
}
