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
import { db } from '@/db/schema';
import { isQuestion, looksLikeAiQuestion } from '@/domain/nlquery';
import { isAggregationQuestion } from '@/domain/search';
import { formatMoney } from '@/domain/money';
import { localView, looksLikeOperation } from '@/domain/agent/intent';
import { currentScreen, useScreen } from '@/stores/screenContext';
import { ViewBubble } from '../ai/views/ViewBubble';
import { aiDataEnabled, aiAsk, aiChatTalk, aiEnabledLocally, aiReceipt, quotaLabel } from '@/services/ai';
import { ask } from '@/services/nlquery';
import { bookDrafts, draftsFromText, draftsSmart, fallbackAccount, isScheduled, resolveDraft, scheduleDrafts, type ResolvedDraft } from '@/services/quickentry';
import { useSettings } from '@/stores/settings';
import { askConfirm, snackUndo, useUI } from '@/stores/ui';
import { AiMark, Icon } from '@/ui/Icon';
import { summarizePlan, type ResolvedStep } from '@/domain/agent/plan';
import type { AgentOpLog } from '@/services/agent';
import { PlanPreview } from '../ai/PlanPreview';
import { Sheet } from '@/ui/Sheet';
import { Switch } from '@/ui/controls';

import { nextSeq, useChat, type Msg, type Reply } from './aiChatStore';

const HAS_AMOUNT_HINT = /\d|[一二兩三四五六七八九十百千萬]/;
/** 在問「我的錢」（要看收支摘要才答得出來）：這類走「問 AI」（扣 1 點）；其餘一般對話走閒聊（不扣額度） */
const WANTS_DATA = /錢包|帳戶|餘額|資產|負債|淨值|存款|多少錢|有多少|花費|花了|開銷|支出|收入|預算|儲蓄|存錢|薪水|信用卡|銀行|現金|分析|檢討|財務|理財/;
const isDataTalk = (t: string, accountNames: string[]) => WANTS_DATA.test(t) || accountNames.some((n) => n && t.includes(n));

/** 規則優先 → 規則查帳 → AI 問答 → AI 解析記帳 → 說明怎麼開啟 */
export async function respond(text: string, screen?: string, onPartial?: (text: string) => void): Promise<Reply> {
  const t = text.trim();
  const asking = isQuestion(t) || looksLikeAiQuestion(t);

  // 對話即介面：「財務自由」「現金流」「如果 55 歲退休」這類短句直接在對話裡出檢視卡（本機運算，不用 AI）
  const view = localView(t);
  if (view) return { role: 'ai', kind: 'view', view };

  // 要整理帳本（批次改分類、設預算、建週期、提前還款）：交給操作助手——先預覽影響、你確認才執行、可一鍵還原
  if (looksLikeOperation(t)) {
    if (!aiEnabledLocally()) return { role: 'ai', kind: 'text', text: '整理帳本的操作需要開啟 AI（它只負責規劃，執行前一定先給你預覽）。', link: { label: '前往 AI 設定', to: '/settings/ai' } };
    // 直接在對話裡規劃並預覽：確認執行、一鍵還原都在這個泡泡完成（AI 只規劃；預覽與執行在本機）
    try {
      const [{ aiAgentPlan }, { previewPlan }] = await Promise.all([import('@/services/ai'), import('@/services/agent')]);
      const r = await aiAgentPlan(t, screen, onPartial ? (summary) => onPartial(`正在規劃：${summary}`) : undefined);
      return { role: 'ai', kind: 'agent', summary: r.plan.summary, steps: await previewPlan(r.plan.steps), raw: r.plan.steps, quota: quotaLabel(r.quota) };
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
  // 問到自己的錢（問句、分析、帳戶餘額…）→ 問 AI（會送去識別化的統計、扣 1 點）；打招呼、閒聊、一般問題 → 閒聊（不送帳務資料、不扣額度）
  const accountNames = asking || !HAS_AMOUNT_HINT.test(t) ? (await db.accounts.toArray().catch(() => [])).map((a) => a.name) : [];
  const dataTalk = asking || isDataTalk(t, accountNames);
  if (dataTalk && aiDataEnabled()) {
    try {
      const r = await aiAsk(t, screen, onPartial);
      return { role: 'ai', kind: 'text', text: r.value.answer, followups: r.value.followups, sub: `${r.cached ? '使用先前的回答（未扣額度）' : r.quota ? quotaLabel(r.quota) : ''}　AI 的回答僅供參考` };
    } catch (e) {
      return { role: 'ai', kind: 'text', text: (e as Error).message };
    }
  }
  if (!dataTalk && aiEnabledLocally() && HAS_AMOUNT_HINT.test(t)) {
    const r = await draftsSmart(t);
    if (r.list.length) return { role: 'ai', kind: 'entries', drafts: r.list, via: r.usedAi ? 'ai' : 'rule', sub: r.quotaText };
    if (r.aiNote) return { role: 'ai', kind: 'text', text: `我看不懂這句話。${r.aiNote}` };
  }
  if (!dataTalk && aiEnabledLocally()) {
    try {
      const r = await aiChatTalk(t, onPartial);
      return { role: 'ai', kind: 'text', text: r.answer, followups: r.followups, sub: '一般對話不扣額度　AI 的回答僅供參考' };
    } catch (e) {
      return { role: 'ai', kind: 'text', text: (e as Error).message };
    }
  }
  const ai = useSettings.getState().ai;
  return {
    role: 'ai', kind: 'text',
    text: asking || dataTalk
      ? '這個問題我用規則回答不了。到「設定 → AI 助理」開啟 AI 並允許分析收支統計，就可以問更複雜的問題。'
      : '我沒有聽出金額。可以試試「午餐 120」「昨天計程車兩百三」，或問「上個月吃飯花多少」。' + (ai?.enabled ? '' : '開啟 AI 後也能請 AI 解析更口語的說法。'),
    link: asking || dataTalk ? { label: '前往 AI 設定', to: '/settings/ai' } : undefined,
  };
}

async function send(text: string, opts: { open?: boolean } = {}) {
  const t = text.trim();
  const st = useChat.getState();
  if (!t || st.busy) return;
  const pending = nextSeq();
  useChat.setState((s) => ({ ...(opts.open === false ? {} : { open: true }), busy: true, msgs: [...s.msgs.slice(-30), { id: nextSeq(), role: 'user', text: t }, { id: pending, role: 'ai', kind: 'pending' }] }));
  try {
    // 「📍 目前畫面」：使用者沒有按掉、而且這句話會送去 AI 時才附上（記帳與規則查帳是本機處理，用不到）
    // 問 AI 的回答是串流的：文字一生出來就顯示在這個泡泡裡（尾端有游標），寫完再換成完整結果（含建議追問與額度）
    const onPartial = (partial: string) => useChat.getState().patch(pending, { role: 'ai', kind: 'text', text: partial, streaming: true } as Partial<Msg>);
    const r = await respond(t, st.attach && aiEnabledLocally() ? currentScreen() || undefined : undefined, onPartial);
    useChat.getState().patch(pending, { ...r, streaming: false } as Partial<Msg>);
  } catch (e) {
    useChat.getState().patch(pending, { role: 'ai', kind: 'text', text: (e as Error).message, streaming: false } as Partial<Msg>);
  } finally { useChat.setState({ busy: false }); }
}

/** 一次最多辨識幾張收據（每張 2 點 AI 額度，上限避免一不小心把額度用光） */
const MAX_BATCH = 8;

/**
 * 收據批次：一次丟好幾張收據／發票照片，逐張辨識（進度顯示在泡泡裡，視窗關掉也會繼續），
 * 全部辨識完放在同一張草稿卡，每一筆可以取消勾選，再一次記帳。某一張失敗不影響其他張，失敗的會列在卡片底下。
 */
async function sendImages(files: File[]) {
  const st = useChat.getState();
  if (st.busy || !files.length) return;
  const list = files.slice(0, MAX_BATCH);
  const pending = nextSeq();
  const patchPending = (p: object) => useChat.getState().patch(pending, p as Partial<Msg>);
  if (!aiEnabledLocally()) {
    useChat.setState((s) => ({ msgs: [...s.msgs.slice(-30), { id: nextSeq(), role: 'user', text: `📷 ${list.length > 1 ? `${list.length} 張收據` : list[0].name || '收據照片'}` }, { id: pending, role: 'ai', kind: 'text', text: '拍照記帳需要開啟 AI（照片縮小後送出，不會保存在伺服器）。', link: { label: '前往 AI 設定', to: '/settings/ai' } }] }));
    return;
  }
  // 超過 2 張要先確認額度：一張 2 點，不要讓人不知不覺用掉一堆
  if (list.length > 2 && !(await askConfirm({ title: `辨識 ${list.length} 張收據？`, message: `每張用 2 點 AI 額度，共 ${list.length * 2} 點。失敗的不扣額度。`, confirmText: '開始辨識', cancelText: '取消' }))) return;
  useChat.setState((s) => ({ busy: true, msgs: [...s.msgs.slice(-30), { id: nextSeq(), role: 'user', text: `📷 ${list.length > 1 ? `${list.length} 張收據` : list[0].name || '收據照片'}${files.length > list.length ? `（一次最多 ${MAX_BATCH} 張，其餘 ${files.length - list.length} 張略過）` : ''}` }, { id: pending, role: 'ai', kind: 'pending' }] }));
  const drafts: ResolvedDraft[] = [];
  const fails: string[] = [];
  let quota = '';
  try {
    const fb = await fallbackAccount();
    for (let i = 0; i < list.length; i++) {
      if (list.length > 1) patchPending({ role: 'ai', kind: 'text', text: `辨識收據 ${i + 1}／${list.length}…（已讀到 ${drafts.length} 筆）` });
      try {
        const r = await aiReceipt(list[i]);
        quota = quotaLabel(r.quota);
        const found = await Promise.all(r.drafts.map((d) => resolveDraft(d, fb)));
        if (!found.length) fails.push(`${list[i].name || `第 ${i + 1} 張`}：看不出消費金額`);
        drafts.push(...found);
      } catch (e) {
        const msg = (e as Error).message;
        fails.push(`${list[i].name || `第 ${i + 1} 張`}：${msg}`);
        if (/額度|quota/i.test(msg)) { fails.push(`額度用完了，剩下 ${list.length - i - 1} 張沒有辨識`); break; }
      }
    }
    const note = fails.length ? `\n沒有辨識到的：${fails.join('；')}` : '';
    patchPending(drafts.length
      ? { role: 'ai', kind: 'entries', drafts, via: 'ai', sub: `${quota}　AI 可能看錯，建議先看過金額再記帳${list.length > 1 ? '；不要的那筆把開關關掉' : '，或「帶入記帳面板」確認'}。${note}` }
      : { role: 'ai', kind: 'text', text: list.length > 1 ? `這 ${list.length} 張都看不出消費金額，請拍清楚一點或改用打字記帳。${note}` : fails[0]?.split('：').slice(1).join('：') || '看不出這張照片的消費金額，請拍清楚一點或改用打字記帳。' });
  } catch (e) {
    patchPending({ role: 'ai', kind: 'text', text: (e as Error).message });
  } finally { useChat.setState({ busy: false }); }
}

// ───────────── 對話彈窗 ─────

function AgentBubble({ m }: { m: Extract<Msg, { kind: 'agent' }> }) {
  const [busy, setBusy] = useState(false);
  // 單步勾選／略過：略過的步驟用 AI 規劃的原始步驟在本機重新預覽（後面步驟的餘額與持股模擬會跟著變），不必再問 AI、不扣額度
  const [off, setOff] = useState<Set<number>>(new Set());
  const [live, setLive] = useState<ResolvedStep[]>(m.steps);
  const patch = (p: Partial<Extract<Msg, { kind: 'agent' }>>) => useChat.getState().patch(m.id, p as Partial<Msg>);
  const diff = summarizePlan(live);
  let j = 0;
  const display = m.raw.map((_, i) => (off.has(i) ? m.steps[i] : live[j++] ?? m.steps[i]));
  const toggle = async (i: number) => {
    const next = new Set(off);
    if (next.has(i)) next.delete(i); else next.add(i);
    setOff(next);
    const { previewPlan } = await import('@/services/agent');
    setLive(await previewPlan(m.raw.filter((_, k) => !next.has(k))));
  };
  const run = async () => {
    setBusy(true);
    try {
      const { applyPlan } = await import('@/services/agent');
      const log = await applyPlan(live, m.summary);
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
      <PlanPreview steps={display} summarySteps={live} off={off} onToggle={m.phase ? undefined : (i) => void toggle(i)} />
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
      {!m.phase && <p className="row-sub" style={{ whiteSpace: 'normal' }}>{m.quota}　執行是「全部成功或全部不動」（可橫跨帳目、帳戶、欠款、股票、目標…），之後 7 天內可整包一鍵還原。</p>}
      {m.phase !== 'cancelled' && live.filter((s) => s.preview.view && !s.preview.blocked).map((s, i) => (
        <ViewBubble key={i} view={s.preview.view!} refreshKey={m.phase === 'done' ? m.opId : undefined} />
      ))}
    </div>
  );
}

function EntriesBubble({ m }: { m: Extract<Msg, { kind: 'entries' }> }) {
  const accounts = useAccounts(true);
  const cats = useCategories();
  const base = useSettings((s) => s.baseCurrency);
  const [busy, setBusy] = useState(false);
  // 多筆草稿（一句話記好幾筆、收據批次）：每筆可以取消勾選，只記勾選的
  const [off, setOff] = useState<Set<number>>(new Set());
  const chosen = m.drafts.filter((_, i) => !off.has(i));
  const multi = m.drafts.length > 1;
  // 日期在未來（或今天還沒到的時間）的那幾筆：建成「單次排程」，到時候通知你、在收件匣按一下才入帳；其他照常馬上記
  const sched = chosen.filter((d) => isScheduled(d));
  const allSched = sched.length === chosen.length && chosen.length > 0;
  const book = async (forceNow = false) => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const later = forceNow ? [] : sched;
      const now = chosen.filter((d) => !later.includes(d));
      const r = now.length ? await bookDrafts(now) : { txIds: [], transferIds: [] };
      const ruleIds = later.length ? await scheduleDrafts(later) : [];
      useChat.getState().patch(m.id, { booked: true, scheduled: ruleIds.length > 0 && !now.length } as Partial<Msg>);
      snackUndo(ruleIds.length ? (now.length ? `已記下 ${now.length} 筆、排程 ${ruleIds.length} 筆` : `已排程 ${ruleIds.length} 筆，到時候通知你`) : `已記下 ${chosen.length} 筆`, async () => {
        if (r.txIds.length) await deleteTransactions(r.txIds);
        if (r.transferIds.length) await deleteTransfers(r.transferIds);
        if (ruleIds.length) await db.recurring_rules.bulkDelete(ruleIds);
        useChat.getState().patch(m.id, { booked: false, scheduled: false } as Partial<Msg>);
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
          <div key={i} className="row" style={off.has(i) ? { opacity: 0.45 } : undefined}>
            {multi && !m.booked && <Switch checked={!off.has(i)} label={`記這一筆：${d.note || formatMoney(Math.round(d.amount * 100), d.currency ?? base, { decimals: 0 })}`}
              onChange={(v) => setOff((o) => { const n = new Set(o); if (v) n.delete(i); else n.add(i); return n; })} />}
            <span className="row-main">
              <span className="row-title num">{d.kind === 'income' ? '＋' : d.kind === 'transfer' ? '↔ ' : '－'}{formatMoney(Math.round(d.amount * 100), d.currency ?? base, { decimals: 0 })}　{d.note || (d.kind === 'transfer' ? '轉帳' : '')}</span>
              <span className="row-sub" style={{ display: 'block' }}>
                {d.kind === 'transfer' ? `${accounts.map.get(d.accountId)?.name ?? ''} → ${accounts.map.get(d.toAccountId ?? '')?.name ?? ''}` : `${cats.map.get(d.categoryId ?? '')?.name ?? '其他'}　${accounts.map.get(d.accountId)?.name ?? ''}`}　{d.date}{d.time ? ` ${d.time}` : ''}{isScheduled(d) ? '　⏰ 排程' : ''}
              </span>
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {m.booked ? <span className="muted">{m.scheduled ? '⏰ 已排程，到時候通知你' : '✅ 已記帳'}</span>
          : <button className="btn small" disabled={busy || !chosen.length} onClick={() => void book()}>{allSched ? `排程提醒（${chosen.length} 筆）` : `記帳（${chosen.length} 筆）`}</button>}
        {!m.booked && sched.length > 0 && <button className="btn small tinted" disabled={busy} onClick={() => void book(true)}>現在就記</button>}
        {!m.booked && m.drafts.length === 1 && <button className="btn small tinted" onClick={toPanel}>帶入記帳面板</button>}
      </div>
      {!m.booked && sched.length > 0 && <div className="row-sub">⏰ 排程的帳不會馬上入帳：到那天{sched[0].time ? '（那個時間）' : ''}會通知你，在收件匣按一下才記下，餘額現在不受影響。</div>}
      {m.sub && <div className="row-sub">{m.sub}</div>}
    </div>
  );
}

/** 空白畫面最多顯示 8 個建議膠囊：畫面專屬（最多 3）＋檢視卡（3）＋範例句（補滿到 8，至少 2） */
const MAX_CHIPS = 8;
const CHAT_EXAMPLES = [
  '昨天午餐 150',
  '這個月哪裡花太多？',
  '把上個月 Uber 歸到交通，並設交通每月預算 3000',
  '我今天領年終 20 萬進台新，拿 5 萬還信貸，再給我看財務自由',
  '以後只要出現 Uber 就自動歸到交通',
  '我今年股利會被扣二代健保嗎？',
];

/** 不用 AI、點了直接在對話裡出檢視卡 */
const VIEW_CHIPS = ['這個月花費', '財務自由', '現金流', '稅務規劃'];

interface ScreenChip { label: string; text: string; /** true＝只把文字填進輸入框（還要補上金額或對象），不直接送出 */ fill?: boolean }
/** 依「目前畫面」插在最上面的專屬晶片：讓人知道現在可以直接講「這檔」「這個帳戶」（本機規則產生，不用 AI） */
function screenChips(screen: string): ScreenChip[] {
  if (screen.startsWith('個股頁')) return [
    { label: '⚡ 買 1 張這檔股票', text: '買 1 張這檔股票' }, { label: '⚡ 賣 1 張這檔股票', text: '賣 1 張這檔股票' }, { label: '⚡ 這檔佔我投資組合多少？', text: '這檔佔我投資組合多少？' },
  ];
  if (screen.startsWith('帳戶明細頁')) return [
    { label: '⚡ 從這個帳戶轉 1 萬到…', text: '從這個帳戶轉 1 萬到', fill: true }, { label: '⚡ 這個帳戶最近花在哪？', text: '這個帳戶最近花在哪？' },
  ];
  if (screen.startsWith('專案與預算 → 應收應付')) return [{ label: '⚡ 把欠款結清', text: '把欠 的款項結清', fill: true }];
  if (screen.startsWith('專案與預算 → 目標')) return [{ label: '⚡ 存 5000 進目標', text: '存 5000 進目標', fill: true }];
  if (screen.startsWith('專案與預算 → 預算')) return [{ label: '⚡ 哪些預算快超支了？', text: '哪些預算快超支了？' }];
  if (screen.startsWith('投資：')) return [{ label: '⚡ 看我的稅務規劃', text: '稅務規劃' }, { label: '⚡ 買 1000 股…', text: '買 1000 股 ', fill: true }];
  if (screen.startsWith('報表：')) return [{ label: '⚡ 哪裡花太多？', text: '這個月哪裡花太多？' }];
  if (screen.startsWith('帳目列表')) return [{ label: '⚡ 這些帳目合計多少？', text: '目前篩選的這些帳目合計多少？' }];
  return [];
}

// 語音輸入（瀏覽器的 SpeechRecognition；iOS Safari 14.5+ 有）：講完把文字填進輸入框，確認後再送出
type SpeechRec = { lang: string; interimResults: boolean; maxAlternatives: number; start: () => void; onresult: ((e: { results: { 0: { 0: { transcript: string } } } }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
const SpeechCtor: (new () => SpeechRec) | undefined = typeof window === 'undefined' ? undefined
  : (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;

/**
 * 對話內容（首頁彈出的對話視窗與 AI 助理頁共用同一份對話）：
 * 記帳、查帳、問 AI、用說的整理帳本（先預覽、確認才執行、可一鍵還原）全部在同一個輸入框，由 respond() 分流。
 */
export function ChatPanel({ onLeave, autoFocus }: { onLeave?: () => void; autoFocus?: boolean }) {
  const navigate = useNavigate();
  const { open, msgs, busy } = useChat();
  const [q, setQ] = useState('');
  const [ops, setOps] = useState<AgentOpLog[]>([]);
  const [listening, setListening] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const aiOn = useSettings((s) => !!s.ai?.enabled);
  const fullScreen = useScreen((s) => s.detail ?? s.routeLabel);
  const screen = fullScreen.slice(0, 60);
  const attach = useChat((s) => s.attach);
  const pendingText = useChat((s) => s.pending);
  useEffect(() => { if (open) end.current?.scrollIntoView({ block: 'end' }); }, [open, msgs]);
  // 別處（搜尋頁、預算頁、舊連結）請對話框代送的一句話：對話視窗載入後自動送出
  useEffect(() => {
    if (pendingText && !useChat.getState().busy) { useChat.setState({ pending: null }); void send(pendingText); }
  }, [pendingText]);
  // 最近 7 天執行過的操作（存在本機，重開 App、清除對話後也還找得到）：隨時可一鍵還原
  const reloadOps = () => { void import('@/services/agent').then((m) => m.listAgentOps()).then(setOps).catch(() => undefined); };
  useEffect(() => { if (open) reloadOps(); }, [open, msgs]);
  const listen = () => {
    if (!SpeechCtor || listening) return;
    const rec = new SpeechCtor();
    rec.lang = 'zh-TW'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => setQ((v) => `${v ? `${v} ` : ''}${e.results[0][0].transcript}`.slice(0, 300));
    rec.onend = () => { setListening(false); inputRef.current?.focus(); };
    rec.onerror = () => { setListening(false); useUI.getState().showSnack({ text: '語音辨識失敗，請確認已允許麥克風' }); };
    setListening(true);
    rec.start();
  };
  const chips = screenChips(fullScreen);
  const pickChip = (c: ScreenChip) => { if (c.fill) { setQ(c.text); inputRef.current?.focus(); } else go(c.text); };
  const undoHistory = async (id: string) => {
    try {
      const { undoOp } = await import('@/services/agent');
      const r = await undoOp(id);
      useUI.getState().showSnack({ text: r.skipped ? `已還原 ${r.restored} 筆；${r.skipped} 筆在執行後又被你改過，沒有動它` : `已還原 ${r.restored} 筆` });
    } catch (e) { useUI.getState().showSnack({ text: (e as Error).message }); }
    reloadOps();
  };
  const go = (text: string) => void send(text);
  const submit = (e: React.FormEvent) => { e.preventDefault(); const t = q; setQ(''); go(t); };

  return (
    <div className="chat-wrap">
      <div className="chat-list" role="log" aria-live="polite">
        {!msgs.length && (
          <div style={{ margin: 8 }}>
            <p className="muted" style={{ margin: '0 0 8px' }}>說一句話就好：記帳、查帳、問問題，或跨帳戶、貸款、股票、欠款一次做完（先預覽、確認才執行、可整包還原）。{aiOn ? '' : '（整理帳本與問 AI 需要先在設定開啟 AI）'}</p>
            {chips.length > 0 && <div className="ask-examples" style={{ marginBottom: 6 }}>{chips.slice(0, 3).map((c) => <button key={c.label} className="pill ctx-chip" disabled={busy} onClick={() => pickChip(c)}>{c.label}</button>)}</div>}
            <div className="ask-examples">{VIEW_CHIPS.slice(0, 3).map((x) => <button key={x} className="pill view-chip" disabled={busy} onClick={() => go(x)}>📊 {x}</button>)}</div>
            <div className="ask-examples" style={{ marginTop: 6 }}>{CHAT_EXAMPLES.slice(0, Math.max(2, MAX_CHIPS - Math.min(chips.length, 3) - 3)).map((x) => <button key={x} className="pill" disabled={busy} onClick={() => go(x)}>{x}</button>)}</div>
          </div>
        )}
        {msgs.map((m) => m.role === 'user' ? (
          <div key={m.id} className="chat-msg me">{m.text}</div>
        ) : (
          <div key={m.id} className="chat-msg ai">
            {m.kind === 'pending' && <span className="muted">思考中…</span>}
            {m.kind === 'text' && (
              <>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}{m.streaming && <span className="stream-caret" aria-hidden="true" />}</div>
                {m.sub && <div className="row-sub" style={{ whiteSpace: 'normal' }}>{m.sub}</div>}
                {m.link && <button className="btn small tinted" style={{ marginTop: 6 }} onClick={() => { onLeave?.(); navigate(m.link!.to); }}>{m.link.label}</button>}
                {!!m.followups?.length && <div className="ask-examples" style={{ marginTop: 6 }}>{m.followups.map((f) => <button key={f} className="pill" disabled={busy} onClick={() => go(f)}>{f}</button>)}</div>}
              </>
            )}
            {m.kind === 'entries' && <EntriesBubble m={m} />}
            {m.kind === 'agent' && <AgentBubble m={m} />}
            {m.kind === 'view' && <ViewBubble view={m.view} />}
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
      {aiOn && screen && (
        <button className={`screen-chip${attach ? ' on' : ''}`} type="button" aria-pressed={attach} onClick={() => useChat.getState().setAttach(!attach)}
          title={attach ? '問 AI 時會一併送出這段畫面摘要（只有名稱與統計數字）；點一下取消' : '點一下，問 AI 時附上目前畫面'}>
          📍 {attach ? `目前畫面：${screen}` : '不附上目前畫面'}{attach && <span aria-hidden="true"> ✕</span>}
        </button>
      )}
      <form className="chat-input" onSubmit={submit}>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; if (fileRef.current) fileRef.current.value = ''; if (fs.length) void sendImages(fs); }} />
        <button className="icon-btn plain" type="button" aria-label="拍照或選擇收據照片（可一次選多張）" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="camera" size={20} /></button>
        {SpeechCtor && <button className="icon-btn plain" type="button" aria-label="語音輸入" aria-pressed={listening} disabled={busy} onClick={listen}
          style={listening ? { background: 'var(--danger)', color: '#fff' } : undefined}><Icon name="mic" size={20} /></button>}
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} enterKeyHint="send" aria-label="輸入訊息" placeholder="記帳、查帳、問或整理帳本" autoFocus={autoFocus} />
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
