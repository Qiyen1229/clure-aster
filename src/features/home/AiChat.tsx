/**
 * 首頁對話框：一個輸入框處理三件事，先用規則（本機、免費、離線），規則做不到才請 AI。
 *   1. 記帳：「昨天午餐 150 刷玉山卡」→ 列出草稿，按「記帳」入帳（可復原）或帶入記帳面板確認
 *   2. 查帳：「上個月吃飯花多少」→ 規則直接回答，並可看符合的帳目
 *   3. 問 AI：「這個月哪裡花太多？」→ 依去識別化的收支統計回答（需在設定開啟，見 docs/AI.md）
 * 對話只存在記憶體（重新整理就清掉），不會寫入資料庫。AI 的輸出一律當純文字顯示。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { useAccounts, useCategories } from '@/app/hooks';
import { deleteTransactions, deleteTransfers } from '@/db/repo/ledger';
import { isQuestion, looksLikeAiQuestion } from '@/domain/nlquery';
import { isAggregationQuestion } from '@/domain/search';
import { formatMoney } from '@/domain/money';
import { aiDataEnabled, aiAsk, aiEnabledLocally, quotaLabel } from '@/services/ai';
import { ask } from '@/services/nlquery';
import { bookDrafts, draftsFromText, draftsSmart, type ResolvedDraft } from '@/services/quickentry';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; kind: 'text'; text: string; sub?: string; link?: { label: string; to: string }; followups?: string[] }
  | { id: number; role: 'ai'; kind: 'entries'; drafts: ResolvedDraft[]; via: 'rule' | 'ai'; sub?: string; booked?: boolean }
  | { id: number; role: 'ai'; kind: 'pending' };

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Reply = DistOmit<Extract<Msg, { role: 'ai' }>, 'id'>;

interface ChatState {
  open: boolean;
  msgs: Msg[];
  busy: boolean;
  setOpen: (v: boolean) => void;
  patch: (id: number, p: Partial<Msg>) => void;
  clear: () => void;
}
let seq = 0;
const useChat = create<ChatState>((set) => ({
  open: false, msgs: [], busy: false,
  setOpen: (open) => set({ open }),
  patch: (id, p) => set((s) => ({ msgs: s.msgs.map((m) => (m.id === id ? ({ ...m, ...p } as Msg) : m)) })),
  clear: () => set({ msgs: [] }),
}));

const HAS_AMOUNT_HINT = /\d|[一二兩三四五六七八九十百千萬]/;

/** 規則優先 → 規則查帳 → AI 問答 → AI 解析記帳 → 說明怎麼開啟 */
export async function respond(text: string): Promise<Reply> {
  const t = text.trim();
  const asking = isQuestion(t) || looksLikeAiQuestion(t);

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
  if (aiDataEnabled()) {
    try {
      const r = await aiAsk(t);
      return { role: 'ai', kind: 'text', text: r.value.answer, followups: r.value.followups, sub: `${r.cached ? '使用先前的回答（未扣額度）' : r.quota ? quotaLabel(r.quota) : ''}　AI 的回答僅供參考` };
    } catch (e) {
      return { role: 'ai', kind: 'text', text: (e as Error).message };
    }
  }
  if (aiEnabledLocally() && HAS_AMOUNT_HINT.test(t)) {
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

async function send(text: string) {
  const t = text.trim();
  const st = useChat.getState();
  if (!t || st.busy) return;
  const pending = ++seq;
  useChat.setState((s) => ({ open: true, busy: true, msgs: [...s.msgs.slice(-30), { id: ++seq, role: 'user', text: t }, { id: pending, role: 'ai', kind: 'pending' }] }));
  try {
    const r = await respond(t);
    useChat.getState().patch(pending, r as Partial<Msg>);
  } catch (e) {
    useChat.getState().patch(pending, { role: 'ai', kind: 'text', text: (e as Error).message } as Partial<Msg>);
  } finally { useChat.setState({ busy: false }); }
}

// ───────────── 首頁上的輸入列 ─────────────

export function AiChatBar() {
  const [q, setQ] = useState('');
  const hasHistory = useChat((s) => s.msgs.length > 0);
  const submit = (e: React.FormEvent) => { e.preventDefault(); const t = q; setQ(''); void send(t); };
  return (
    <form className="ai-bar" onSubmit={submit} aria-label="對話框">
      <span className="ai-bar-icon" aria-hidden="true">✨</span>
      <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} enterKeyHint="send" aria-label="對話框輸入"
        placeholder="AI 記帳或問問題" />
      {hasHistory && !q && <button type="button" className="icon-btn plain" aria-label="開啟對話紀錄" onClick={() => useChat.getState().setOpen(true)}><Icon name="list" size={20} /></button>}
      <button type="submit" className="btn small" disabled={!q.trim()}>送出</button>
    </form>
  );
}

// ───────────── 對話彈窗 ─────────────

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
      <div>{m.via === 'ai' ? '✨ AI 幫你整理成這樣：' : '看起來是這幾筆：'}</div>
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

export function AiChatSheet() {
  const navigate = useNavigate();
  const { open, msgs, busy, setOpen, clear } = useChat();
  const [q, setQ] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const aiOn = useSettings((s) => !!s.ai?.enabled);
  useEffect(() => { if (open) end.current?.scrollIntoView({ block: 'end' }); }, [open, msgs]);
  const submit = (e: React.FormEvent) => { e.preventDefault(); const t = q; setQ(''); void send(t); };

  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="對話" full
      right={msgs.length ? <button className="accent" onClick={clear}>清除</button> : undefined}>
      <div className="chat-wrap">
        <div className="chat-list" role="log" aria-live="polite">
          {!msgs.length && <p className="muted" style={{ margin: 8 }}>說一句話就好：「昨天午餐 150」會幫你記帳，「上個月吃飯花多少」會幫你查帳{aiOn ? '，也可以問「這個月哪裡花太多？」' : ''}。</p>}
          {msgs.map((m) => m.role === 'user' ? (
            <div key={m.id} className="chat-msg me">{m.text}</div>
          ) : (
            <div key={m.id} className="chat-msg ai">
              {m.kind === 'pending' && <span className="muted">思考中…</span>}
              {m.kind === 'text' && (
                <>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                  {m.sub && <div className="row-sub" style={{ whiteSpace: 'normal' }}>{m.sub}</div>}
                  {m.link && <button className="btn small tinted" style={{ marginTop: 6 }} onClick={() => { setOpen(false); navigate(m.link!.to); }}>{m.link.label}</button>}
                  {!!m.followups?.length && <div className="ask-examples" style={{ marginTop: 6 }}>{m.followups.map((f) => <button key={f} className="pill" disabled={busy} onClick={() => void send(f)}>{f}</button>)}</div>}
                </>
              )}
              {m.kind === 'entries' && <EntriesBubble m={m} />}
            </div>
          ))}
          <div ref={end} />
        </div>
        <form className="chat-input" onSubmit={submit}>
          <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} enterKeyHint="send" aria-label="輸入訊息" placeholder="輸入訊息…" />
          <button className="btn small" type="submit" disabled={busy || !q.trim()}>送出</button>
        </form>
      </div>
    </Sheet>
  );
}
