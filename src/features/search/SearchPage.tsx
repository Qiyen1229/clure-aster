/**
 * 全域搜尋：帳目與「轉帳」（備註、商家、發票號碼、分類、帳戶、標籤、專案、金額、日期、類型）。
 * 多個條件以空白分隔、全部符合才算，例如「5000 轉帳 上週」「麥當勞 10/25」「1000-5000 #旅遊」，規則見 domain/search。
 * 結果依日期新到舊，最多顯示 300 筆。
 * 用問的查帳：輸入「上個月吃飯花多少」這類問句時，規則看得懂就直接回答並列出符合的帳目（services/nlquery，本機、免費）；
 * 規則看不懂的自然語言一律交給 AI 對話框（直接在這一頁上方開啟對話視窗並送出），搜尋頁不再自己養一套 AI 搜尋。
 * 桌機可用 ⌘K / Ctrl+K 開啟。
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAccounts, useCategories, useProjects, useTags } from '@/app/hooks';
import { describeTerm, parseSearch, preferPlainSearch } from '@/domain/search';
import { todayKey } from '@/domain/period';
import { searchLedger } from '@/services/search';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { LedgerRow } from '../ledger/LedgerRow';
import { isQuestion, rangeText } from '@/domain/nlquery';
import { ask, type QueryAnswer } from '@/services/nlquery';

const EXAMPLES = ['上個月吃飯花多少', '這週咖啡喝了幾次', '今年最大一筆', '上個月錢都花到哪', '最近 30 天平均每天花多少', '去年收入多少'];
const TIPS = ['5000', '5000 轉帳', '10/25 午餐', '1000-5000 上週', '>=3000 #旅遊', '@玉山 本月', '麥當勞 支出'];

export default function SearchPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDeferredValue(q.trim());
  const inputRef = useRef<HTMLInputElement>(null);
  const accounts = useAccounts(true);
  const cats = useCategories();
  const tags = useTags();
  const projects = useProjects();
  const weekStart = useSettings((st) => st.weekStart);
  const baseCurrency = useSettings((st) => st.baseCurrency);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // 問句：回答並改用查詢條件列出帳目
  const parsed = useMemo(() => parseSearch(dq, { today: todayKey(), weekStart }), [dq, weekStart]);
  const question = !!dq && isQuestion(dq) && !preferPlainSearch(dq, parsed);
  // 答案記住是哪一句的：改了問題還沒算好前不顯示舊答案
  const [answered, setAnswered] = useState<{ text: string; a: QueryAnswer | null } | null>(null);
  useEffect(() => {
    if (!question) { setAnswered(null); return; }
    let alive = true;
    const t = setTimeout(() => void ask(dq).then((a) => alive && setAnswered({ text: dq, a })).catch(() => alive && setAnswered({ text: dq, a: null })), 250);
    return () => { alive = false; clearTimeout(t); };
  }, [dq, question]);
  const answer = answered?.text === dq ? answered.a : null;

  // 規則看得懂的問題直接回答；看不懂（或不是問題）就用一般搜尋
  const ruleFailed = question && answered?.text === dq && !answer;
  const matchCtx = useMemo(() => ({ cats: cats.map, accounts: accounts.map, tags: tags.map, projects: projects.map, baseCurrency }), [cats.map, accounts.map, tags.map, projects.map, baseCurrency]);
  const search = useLiveQuery(async () => {
    if (!dq || (question && !ruleFailed)) return null;
    return searchLedger(parsed, matchCtx);
  }, [dq, question, ruleFailed, parsed, matchCtx]);

  const results = search?.items;
  const lowDq = dq.toLowerCase();
  const chips = parsed.terms.length > 1 || parsed.terms.some((t) => t.kind !== 'text') ? parsed.terms.map(describeTerm) : [];

  const matchedAccounts = dq && parsed.terms.length === 1 && parsed.terms[0].kind === 'text' ? accounts.all.filter((a) => a.name.toLowerCase().includes(lowDq)) : [];

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <div style={{ flex: 1, position: 'relative' }}>
          <input ref={inputRef} className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋備註、金額，或直接輸入問題" aria-label="搜尋" enterKeyHint="search" style={{ paddingLeft: 38 }} />
          <span className="faint" style={{ position: 'absolute', left: 11, top: 12 }}><Icon name="search" size={20} /></span>
        </div>
      </header>

      {!dq ? (
        <>
          <EmptyState emoji="🔎" title="搜尋帳目與轉帳" text="輸入關鍵字、帳戶名稱、金額區間，或直接輸入問句查詢。" />
          <div className="section-title">快速篩選範例</div>
          <div className="ask-examples">
            {TIPS.map((x) => <button key={x} className="pill" onClick={() => setQ(x)}>{x}</button>)}
          </div>
          <div className="section-title">自然語言查詢</div>
          <div className="ask-examples">
            {EXAMPLES.map((x) => <button key={x} className="pill" onClick={() => setQ(x)}>{x}</button>)}
          </div>
        </>
      ) : question && (!answered || answered.text !== dq) ? (
        <SkeletonRows n={2} />
      ) : question && answer ? (
        <>
          <section className="card ask-answer" aria-live="polite">
            <p className="ask-text">{answer.answer}</p>
            {answer.detail && <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.88rem' }}>{answer.detail}</p>}
            <div className="ask-chips" aria-label="我理解的條件">
              <span className="chip">{answer.query.rangeLabel}（{rangeText(answer.query.range)}）</span>
              <span className="chip">{answer.query.kind === 'income' ? '收入' : '支出'}</span>
              {answer.query.categoryLabel && <span className="chip">{answer.query.categoryLabel}</span>}
              {answer.query.keyword && <span className="chip">{answer.query.keyword}</span>}
              {answer.query.accountIds.map((id) => <span key={id} className="chip">{accounts.map.get(id)?.icon} {accounts.map.get(id)?.name}</span>)}
            </div>
          </section>
          <div className="section-title">符合的帳目（{answer.items.length}）</div>
          {answer.items.slice(0, 300).map((t) => (
            <LedgerRow key={t.id} item={{ kind: 'tx', id: t.id, date: t.date, ts: t.ts, tx: t }} cats={cats.map} accounts={accounts.map} tags={tags.map} showDate />
          ))}
        </>
      ) : (
        <>
          {chips.length > 0 && (
            <div className="ask-chips" aria-label="我理解的搜尋條件" style={{ margin: '0 4px 8px' }}>
              {chips.map((c, i) => <span key={i} className="chip">{c}</span>)}
            </div>
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
          <div className="section-title">帳目 {results ? `（${results.length}${search?.truncated ? '+' : ''}）` : ''}</div>
          {results?.length === 0 ? <EmptyState emoji="🫥" title="沒有符合的帳目" text="請減少篩選條件或更換關鍵字再試試" /> : results?.map((it) => (
            <LedgerRow key={`${it.kind}:${it.id}`} item={it} cats={cats.map} accounts={accounts.map} tags={tags.map} showDate />
          ))}
        </>
      )}
    </main>
  );
}
