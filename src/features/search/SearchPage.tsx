/**
 * 全域搜尋：帳目（備註、分類、帳戶、標籤、金額）＋帳戶。結果依日期新到舊，最多顯示 300 筆。
 * 用問的查帳：輸入「上個月吃飯花多少」這類問句時，直接回答並列出符合的帳目（services/nlquery）。
 * 桌機可用 ⌘K / Ctrl+K 開啟。
 */
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { LedgerItem } from '@/db/repo/ledger';
import { fromMinor } from '@/domain/money';
import { useAccounts, useCategories, useTags } from '@/app/hooks';
import { Icon } from '@/ui/Icon';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { LedgerRow } from '../ledger/LedgerRow';
import { isQuestion, looksLikeAiQuestion, rangeText } from '@/domain/nlquery';
import { ask, type QueryAnswer } from '@/services/nlquery';
import { aiEnabledLocally } from '@/services/ai';

const EXAMPLES = ['上個月吃飯花多少', '這週咖啡喝了幾次', '今年最大一筆', '上個月錢都花到哪', '最近 30 天平均每天花多少', '去年收入多少'];

export default function SearchPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDeferredValue(q.trim().toLowerCase());
  const inputRef = useRef<HTMLInputElement>(null);
  const accounts = useAccounts(true);
  const cats = useCategories();
  const tags = useTags();

  useEffect(() => { inputRef.current?.focus(); }, []);

  // 問句：回答並改用查詢條件列出帳目
  const question = !!dq && isQuestion(dq);
  // 答案記住是哪一句的：改了問題還沒算好前不顯示舊答案
  const [answered, setAnswered] = useState<{ text: string; a: QueryAnswer | null } | null>(null);
  useEffect(() => {
    if (!question) { setAnswered(null); return; }
    let alive = true;
    const t = setTimeout(() => void ask(dq).then((a) => alive && setAnswered({ text: dq, a })).catch(() => alive && setAnswered({ text: dq, a: null })), 250);
    return () => { alive = false; clearTimeout(t); };
  }, [dq, question]);
  const answer = answered?.text === dq ? answered.a : null;

  const results = useLiveQuery(async () => {
    if (!dq || question) return [] as LedgerItem[];
    const catIds = new Set(cats.all.filter((c) => c.name.toLowerCase().includes(dq)).flatMap((c) => [c.id, ...cats.all.filter((s) => s.parentId === c.id).map((s) => s.id)]));
    const accIds = new Set(accounts.all.filter((a) => a.name.toLowerCase().includes(dq)).map((a) => a.id));
    const tagIds = new Set(tags.list.filter((t) => t.name.toLowerCase().includes(dq)).map((t) => t.id));
    const out: LedgerItem[] = [];
    await db.transactions.orderBy('date').reverse().until(() => out.length >= 300).each((t) => {
      if (t.deletedAt || t.transferId) return;
      const amt = fromMinor(t.amountMinor, t.currency).toString();
      if (t.note.toLowerCase().includes(dq) || catIds.has(t.categoryId) || accIds.has(t.accountId) || t.tagIds.some((x) => tagIds.has(x)) || amt === dq) {
        out.push({ kind: 'tx', id: t.id, date: t.date, ts: t.ts, tx: t });
      }
    });
    return out;
  }, [dq, question, cats.all, accounts.all, tags.list]);

  const matchedAccounts = dq ? accounts.all.filter((a) => a.name.toLowerCase().includes(dq)) : [];

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <div style={{ flex: 1, position: 'relative' }}>
          <input ref={inputRef} className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋，或直接問：上個月吃飯花多少" aria-label="搜尋" enterKeyHint="search" style={{ paddingLeft: 38 }} />
          <span className="faint" style={{ position: 'absolute', left: 11, top: 12 }}><Icon name="search" size={20} /></span>
        </div>
      </header>

      {!dq ? (
        <>
          <EmptyState emoji="🔎" title="想找哪一筆？" text={<>可以搜尋「午餐」、「Netflix」、帳戶名稱或金額「120」，<br />也可以直接用問的。<span className="kbd">⌘K</span> 隨時開啟搜尋</>} />
          <div className="section-title">試試看用問的</div>
          <div className="ask-examples">
            {EXAMPLES.map((x) => <button key={x} className="pill" onClick={() => setQ(x)}>💬 {x}</button>)}
          </div>
        </>
      ) : question ? (
        !answered || answered.text !== dq ? <SkeletonRows n={2} /> : !answer ? (
          <section className="card ask-answer">
            <p className="ask-text">💬 這個問題我用規則看不懂。</p>
            {aiEnabledLocally()
              ? <button className="btn small" onClick={() => navigate(`/ai?q=${encodeURIComponent(q.trim())}`)}>✨ 問 AI</button>
              : <p className="muted" style={{ margin: '4px 0 0' }}>到「設定 → AI 助理」開啟 AI 後，可以問更複雜的問題。</p>}
          </section>
        ) : (
          <>
            <section className="card ask-answer" aria-live="polite">
              <p className="ask-text">💬 {answer.answer}</p>
              {answer.detail && <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.88rem' }}>{answer.detail}</p>}
              <div className="ask-chips" aria-label="我理解的條件">
                <span className="chip">📅 {answer.query.rangeLabel}（{rangeText(answer.query.range)}）</span>
                <span className="chip">{answer.query.kind === 'income' ? '💰 收入' : '💸 支出'}</span>
                {answer.query.categoryLabel && <span className="chip">🏷 {answer.query.categoryLabel}</span>}
                {answer.query.keyword && <span className="chip">🔎 {answer.query.keyword}</span>}
                {answer.query.accountIds.map((id) => <span key={id} className="chip">{accounts.map.get(id)?.icon} {accounts.map.get(id)?.name}</span>)}
              </div>
            </section>
            <div className="section-title">符合的帳目（{answer.items.length}）</div>
            {answer.items.slice(0, 300).map((t) => (
              <LedgerRow key={t.id} item={{ kind: 'tx', id: t.id, date: t.date, ts: t.ts, tx: t }} cats={cats.map} accounts={accounts.map} tags={tags.map} showDate />
            ))}
          </>
        )
      ) : (
        <>
          {aiEnabledLocally() && looksLikeAiQuestion(q) && (
            <section className="card ask-answer">
              <p className="ask-text">✨ 這像是一個請教的問題，要問 AI 嗎？</p>
              <button className="btn small" onClick={() => navigate(`/ai?q=${encodeURIComponent(q.trim())}`)}>問 AI</button>
            </section>
          )}
          {matchedAccounts.length > 0 && (
            <>
              <div className="section-title">帳戶</div>
              <div className="list">
                {matchedAccounts.map((a) => (
                  <button key={a.id} className="row" onClick={() => navigate(`/accounts/${a.id}`)}>
                    <span aria-hidden="true">{a.icon}</span><span className="row-main">{a.name}</span><Icon name="chevronR" className="row-chev" />
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="section-title">帳目 {results ? `（${results.length}${results.length >= 300 ? '+' : ''}）` : ''}</div>
          {results?.length === 0 ? <EmptyState emoji="🫥" title="沒有符合的帳目" /> : results?.map((it) => (
            <LedgerRow key={it.id} item={it} cats={cats.map} accounts={accounts.map} tags={tags.map} showDate />
          ))}
        </>
      )}
    </main>
  );
}
