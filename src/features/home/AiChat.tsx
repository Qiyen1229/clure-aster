/**
 * 首頁對話框：一個輸入框處理三件事，先用規則（本機、免費、離線），規則做不到才請 AI。
 *   1. 記帳：「昨天午餐 150 刷玉山卡」→ 列出草稿，按「記帳」入帳（可復原）或帶入記帳面板確認
 *   2. 查帳：「上個月吃飯花多少」→ 規則直接回答，並可看符合的帳目
 *   3. 問 AI：「這個月哪裡花太多？」→ 依去識別化的收支統計回答（需在設定開啟，見 docs/AI.md）
 * 對話只存在記憶體（重新整理就清掉），不會寫入資料庫。AI 的輸出一律當純文字顯示。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts, useCategories } from '@/app/hooks';
import { deleteTransactions, deleteTransfers } from '@/db/repo/ledger';
import { isQuestion, looksLikeAiQuestion } from '@/domain/nlquery';
import { isAggregationQuestion } from '@/domain/search';
import { formatMoney } from '@/domain/money';
import { looksLikeOperation } from '@/domain/agent/intent';
import { aiDataEnabled, aiAsk, aiEnabledLocally, quotaLabel } from '@/services/ai';
import { ask } from '@/services/nlquery';
import { bookDrafts, draftsFromText, draftsSmart } from '@/services/quickentry';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { AiMark } from '@/ui/Icon';
import { summarizePlan } from '@/domain/agent/plan';
import type { AgentOpLog } from '@/services/agent';
import { PlanPreview } from '../ai/PlanPreview';
import { Sheet } from '@/ui/Sheet';

import { nextSeq, useChat, type Msg, type Reply } from './aiChatStore';

const HAS_AMOUNT_HINT = /\d|[一二兩三四五六七八九十百千萬]/;

/** 規則優先 → 規則查帳 → AI 問答 → AI 解析記帳 → 說明怎麼開啟 */
export async function respond(text: string): Promise<Reply> {
  const t = text.trim();
  const asking = isQuestion(t) || looksLikeAiQuestion(t);

  // 要整理帳本（批次改分類、設預算、建週期、提前還款）：交給操作助手——先預覽影響、你確認才執行、可一鍵還原
  if (looksLikeOperation(t)) {
    if (!aiEnabledLocally()) return { role: 'ai', kind: 'text', text: '整理帳本的操作需要開啟 AI（它只負責規劃，執行前一定先給你預覽）。', link: { label: '前往 AI 設定', to: '/settings/ai' } };
    // 直接在對話裡規劃並預覽：確認執行、一鍵還原都在這個泡泡完成（AI 只規劃；預覽與執行在本機）
    try {
      const [{ aiAgentPlan }, { previewPlan }] = await Promise.all([import('@/services/ai'), import('@/services/agent')]);
      const r = await aiAgentPlan(t);
      return { role: 'ai', kind: 'agent', summary: r.plan.summary, steps: await previewPlan(r.plan.steps), quota: quotaLabel(r.quota) };
    } catch (e) {
      return { role: 'ai', kind: 'text', text: (e as Error).message };
    }
  }

  // 先當記帳：「昨天午餐 150」這類說法帶有日期詞，isQuestion 會誤判成查帳，所以只要有金額、又不是統計問法（多少、幾次、最大…）就先試著記帳
  if (!isAggregationQuestion(t) && !looksLikeAiQuestion(t)) {
    const drafts = await draftsFromText(t).catch(() => []);
    if (drafts.length) return { role: 'ai', kind: 'entries', drafts, via: 'rule' };
  }
  if (isQuestion(t)) {
    const a = await ask(t).catch(() => null);
    // 規則查到 0 筆、而且 AI 可以回答時，交給 AI（例如「這個月哪裡花太多？」會被規則誤認成關鍵字「太多」）
    if (a && (a.items.length > 0 || !aiDataEnabled())) return { role: 'ai', kind: 'text', text: a.answer, sub: a.detail, link: a.items.length ? { label: `查看符合的 ${a.items.length} 筆帳目`, to: `/search?q=${encodeURIComponent(t)}` } : undefined };
  }
  // 只有「問句」才交給 AI 問答（會送統計、扣 1 點）；「你好」之類不是問句的不要白扣額度，非問句又有金額的才走 AI 口語記帳
  if (asking && aiDataEnabled()) {
    try {
      const r = await aiAsk(t);
      return { role: 'ai', kind: 'text', text: r.value.answer, followups: r.value.followups, sub: `${r.cached ? '使用先前的回答（未扣額度）' : r.quota ? quotaLabel(r.quota) : ''}　AI 的回答僅供參考` };
    } catch (e) {
      return { role: 'ai', kind: 'text', text: (e as Error).message };
    }
  }
  if (!asking && aiEnabledLocally() && HAS_AMOUNT_HINT.test(t)) {
    const r = await draftsSmart(t);
    if (r.list.length) return { role: 'ai', kind: 'entries', drafts: r.list, via: r.usedAi ? 'ai' : 'rule', sub: r.quotaText };
    if (r.aiNote) return { role: 'ai', kind: 'text', text: `我看不懂這句話。${r.aiNote}` };
  }
  const ai = useSettings.getState().ai;
  return {
    role: 'ai', kind: 'text',
    text: asking
      ? '這個問題我用規則回答不了。到「設定 → AI 助理」開啟 AI 並允許分析收支統計，就可以問更複雜的問題。'
      : '我沒有聽出金額。可以試試「午餐 120」「昨天計程車兩百三」，或問「上個月吃飯花多少」。' + (ai?.enabled ? '' : '開啟 AI 後也能請 AI 解析更口語的說法。'),
    link: asking ? { label: '前往 AI 設定', to: '/settings/ai' } : undefined,
  };
}

async function send(text: string, opts: { open?: boolean } = {}) {
  const t = text.trim();
  const st = useChat.getState();
  if (!t || st.busy) return;
  const pending = nextSeq();
  useChat.setState((s) => ({ ...(opts.open === false ? {} : { open: true }), busy: true, msgs: [...s.msgs.slice(-30), { id: nextSeq(), role: 'user', text: t }, { id: pending, role: 'ai', kind: 'pending' }] }));
  try {
    const r = await respond(t);
    useChat.getState().patch(pending, r as Partial<Msg>);
  } catch (e) {
    useChat.getState().patch(pending, { role: 'ai', kind: 'text', text: (e as Error).message } as Partial<Msg>);
  } finally { useChat.setState({ busy: false }); }
}

// ───────────── 對話彈窗 ─────────────

function AgentBubble({ m }: { m: Extract<Msg, { kind: 'agent' }> }) {
  const [busy, setBusy] = useState(false);
  const diff = summarizePlan(m.steps);
  const patch = (p: Partial<Extract<Msg, { kind: 'agent' }>>) => useChat.getState().patch(m.id, p as Partial<Msg>);
  const run = async () => {
    setBusy(true);
    try {
      const { applyPlan } = await import('@/services/agent');
      const log = await applyPlan(m.steps, m.summary);
      patch({ phase: 'done', opId: log.id, note: `已執行 ${log.titles.length} 項操作` });
    } catch (e) { patch({ note: `執行失敗，沒有任何資料被改動：${(e as Error).message}` }); } finally { setBusy(false); }
  };
  const undo = async () => {
    if (!m.opId) return;
    setBusy(true);
    try {
      const { undoOp } = await import('@/services/agent');
      const r = await undoOp(m.opId);
      patch({ phase: 'undone', note: r.skipped ? `已還原 ${r.restored} 筆；${r.skipped} 筆在執行後又被你改過，沒有動它` : `已還原 ${r.restored} 筆` });
    } catch (e) { patch({ note: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <div className="agent-preview">
      <div className="row-title" style={{ whiteSpace: 'normal' }}>執行預覽{m.summary ? `：${m.summary}` : ''}</div>
      <PlanPreview steps={m.steps} />
      {!m.phase && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn secondary small" style={{ flex: 1 }} disabled={busy} onClick={() => patch({ phase: 'cancelled', note: '已取消，沒有改動任何資料' })}>取消</button>
          <button className="btn small" style={{ flex: 2 }} disabled={busy || !diff.executable} onClick={() => void run()}>
            {diff.executable ? `確認執行（${diff.executable} 項）` : diff.readonly ? '這是試算，不需要執行' : '沒有可以執行的步驟'}
          </button>
        </div>
      )}
      {m.phase === 'done' && <button className="btn small tinted" style={{ marginTop: 10 }} disabled={busy} onClick={() => void undo()}>✅ 已執行・一鍵還原</button>}
      {m.note && <p className="row-sub" style={{ whiteSpace: 'normal' }}>{m.note}</p>}
      {!m.phase && <p className="row-sub" style={{ whiteSpace: 'normal' }}>{m.quota}　執行是「全部成功或全部不動」，之後 7 天內可一鍵還原。</p>}
    </div>
  );
}

function EntriesBubble({ m }: { m: Extract<Msg, { kind: 'entries' }> }) {
  const accounts = useAccounts(true);
  const cats = useCategories();
  const base = useSettings((s) => s.baseCurrency);
  const [busy, setBusy] = useState(false);
  const book = async () => {
    setBusy(true);
    try {
      const r = await bookDrafts(m.drafts);
      useChat.getState().patch(m.id, { booked: true } as Partial<Msg>);
      snackUndo(`已記下 ${m.drafts.length} 筆`, async () => {
        if (r.txIds.length) await deleteTransactions(r.txIds);
        if (r.transferIds.length) await deleteTransfers(r.transferIds);
        useChat.getState().patch(m.id, { booked: false } as Partial<Msg>);
      });
    } catch (e) { useUI.getState().showSnack({ text: (e as Error).message }); } finally { setBusy(false); }
  };
  const toPanel = () => {
    const d = m.drafts[0];
    useChat.getState().setOpen(false);
    useUI.getState().openAdd({ mode: d.kind, amount: String(d.amount), categoryId: d.categoryId, accountId: d.accountId, toAccountId: d.toAccountId, note: d.note, date: d.date });
  };
  return (
    <div>
      <div>{m.via === 'ai' ? <><AiMark /> AI 幫你整理成這樣：</> : '看起來是這幾筆：'}</div>
      <div className="list" style={{ marginTop: 6 }}>
        {m.drafts.map((d, i) => (
          <div key={i} className="row">
            <span className="row-main">
              <span className="row-title num">{d.kind === 'income' ? '＋' : d.kind === 'transfer' ? '↔ ' : '－'}{formatMoney(Math.round(d.amount * 100), d.currency ?? base, { decimals: 0 })}　{d.note || (d.kind === 'transfer' ? '轉帳' : '')}</span>
              <span className="row-sub" style={{ display: 'block' }}>
                {d.kind === 'transfer' ? `${accounts.map.get(d.accountId)?.name ?? ''} → ${accounts.map.get(d.toAccountId ?? '')?.name ?? ''}` : `${cats.map.get(d.categoryId ?? '')?.name ?? '其他'}　${accounts.map.get(d.accountId)?.name ?? ''}`}　{d.date}
              </span>
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {m.booked ? <span className="muted">✅ 已記帳</span> : <button className="btn small" disabled={busy} onClick={() => void book()}>記帳（{m.drafts.length} 筆）</button>}
        {!m.booked && m.drafts.length === 1 && <button className="btn small tinted" onClick={toPanel}>帶入記帳面板</button>}
      </div>
      {m.sub && <div className="row-sub">{m.sub}</div>}
    </div>
  );
}

const CHAT_EXAMPLES = [
  '昨天午餐 150',
  '上個月吃飯花多少',
  '這個月哪裡花太多？',
  '把上個月 Uber 歸到交通，並設交通每月預算 3000',
  '以後只要出現 Uber 就自動歸到交通',
  '我今年股利會被扣二代健保嗎？',
];

/**
 * 對話內容（首頁彈出的對話視窗與 AI 助理頁共用同一份對話）：
 * 記帳、查帳、問 AI、用說的整理帳本（先預覽、確認才執行、可一鍵還原）全部在同一個輸入框，由 respond() 分流。
 */
export function ChatPanel({ embedded, onLeave, autoSend, onAutoSent, autoFocus }: { embedded?: boolean; onLeave?: () => void; autoSend?: string; onAutoSent?: () => void; autoFocus?: boolean }) {
  const navigate = useNavigate();
  const { open, msgs, busy } = useChat();
  const [q, setQ] = useState('');
  const [ops, setOps] = useState<AgentOpLog[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const sent = useRef(false);
  const aiOn = useSettings((s) => !!s.ai?.enabled);
  useEffect(() => { if (embedded || open) end.current?.scrollIntoView({ block: 'end' }); }, [embedded, open, msgs]);
  useEffect(() => { if (autoSend && !sent.current) { sent.current = true; onAutoSent?.(); void send(autoSend, { open: !embedded }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 最近 7 天執行過的操作（存在本機，重開 App、清除對話後也還找得到）：隨時可一鍵還原
  const reloadOps = () => { void import('@/services/agent').then((m) => m.listAgentOps()).then(setOps).catch(() => undefined); };
  useEffect(() => { if (embedded || open) reloadOps(); }, [embedded, open, msgs]);
  const undoHistory = async (id: string) => {
    try {
      const { undoOp } = await import('@/services/agent');
      const r = await undoOp(id);
      useUI.getState().showSnack({ text: r.skipped ? `已還原 ${r.restored} 筆；${r.skipped} 筆在執行後又被你改過，沒有動它` : `已還原 ${r.restored} 筆` });
    } catch (e) { useUI.getState().showSnack({ text: (e as Error).message }); }
    reloadOps();
  };
  const go = (text: string) => void send(text, { open: !embedded });
  const submit = (e: React.FormEvent) => { e.preventDefault(); const t = q; setQ(''); go(t); };

  return (
    <div className={`chat-wrap${embedded ? ' embedded' : ''}`}>
      <div className="chat-list" role="log" aria-live="polite">
        {!msgs.length && (
          <div style={{ margin: 8 }}>
            <p className="muted" style={{ margin: '0 0 8px' }}>說一句話就好：記帳、查帳、問問題，或直接叫我整理帳本。{aiOn ? '' : '（整理帳本與問 AI 需要先在設定開啟 AI）'}</p>
            <div className="ask-examples">{CHAT_EXAMPLES.map((x) => <button key={x} className="pill" disabled={busy} onClick={() => go(x)}>{x}</button>)}</div>
          </div>
        )}
        {msgs.map((m) => m.role === 'user' ? (
          <div key={m.id} className="chat-msg me">{m.text}</div>
        ) : (
          <div key={m.id} className="chat-msg ai">
            {m.kind === 'pending' && <span className="muted">思考中…</span>}
            {m.kind === 'text' && (
              <>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                {m.sub && <div className="row-sub" style={{ whiteSpace: 'normal' }}>{m.sub}</div>}
                {m.link && <button className="btn small tinted" style={{ marginTop: 6 }} onClick={() => { onLeave?.(); navigate(m.link!.to); }}>{m.link.label}</button>}
                {!!m.followups?.length && <div className="ask-examples" style={{ marginTop: 6 }}>{m.followups.map((f) => <button key={f} className="pill" disabled={busy} onClick={() => go(f)}>{f}</button>)}</div>}
              </>
            )}
            {m.kind === 'entries' && <EntriesBubble m={m} />}
            {m.kind === 'agent' && <AgentBubble m={m} />}
          </div>
        ))}
        <div ref={end} />
      </div>
      {ops.length > 0 && (
        <details className="agent-history" style={{ margin: '4px 8px' }}>
          <summary>最近的操作（{ops.length}，7 天內可還原）</summary>
          {ops.map((h) => (
            <div key={h.id} className="row" style={{ gap: 8 }}>
              <span className="row-main">
                <span className="row-title" style={{ whiteSpace: 'normal' }}>{h.summary}</span>
                <span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>{new Date(h.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　{h.titles.join('；')}</span>
              </span>
              {h.undoneAt ? <span className="muted">已還原</span> : <button className="btn small tinted" onClick={() => void undoHistory(h.id)}>還原</button>}
            </div>
          ))}
        </details>
      )}
      <form className="chat-input" onSubmit={submit}>
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} enterKeyHint="send" aria-label="輸入訊息" placeholder="記帳、查帳、問或整理帳本" autoFocus={autoFocus} />
        <button className="btn small" type="submit" disabled={busy || !q.trim()}>送出</button>
      </form>
    </div>
  );
}

export function AiChatSheet() {
  const { open, msgs, setOpen, clear } = useChat();
  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="對話" full variant="rise"
      right={msgs.length ? <button className="accent" onClick={clear}>清除</button> : undefined}>
      <ChatPanel onLeave={() => setOpen(false)} autoFocus />
    </Sheet>
  );
}
