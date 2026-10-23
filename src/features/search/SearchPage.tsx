/**
 * 全域搜尋：帳目（備註、分類、帳戶、標籤、金額）＋帳戶。結果依日期新到舊，最多顯示 300 筆。
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
import { EmptyState } from '@/ui/controls';
import { LedgerRow } from '../ledger/LedgerRow';

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

  const results = useLiveQuery(async () => {
    if (!dq) return [] as LedgerItem[];
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
  }, [dq, cats.all, accounts.all, tags.list]);

  const matchedAccounts = dq ? accounts.all.filter((a) => a.name.toLowerCase().includes(dq)) : [];

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <div style={{ flex: 1, position: 'relative' }}>
          <input ref={inputRef} className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋備註、分類、帳戶、標籤、金額" aria-label="搜尋" enterKeyHint="search" style={{ paddingLeft: 38 }} />
          <span className="faint" style={{ position: 'absolute', left: 11, top: 12 }}><Icon name="search" size={20} /></span>
        </div>
      </header>

      {!dq ? (
        <EmptyState emoji="🔎" title="想找哪一筆？" text={<>可以搜尋「午餐」、「Netflix」、帳戶名稱或金額「120」。<br /><span className="kbd">⌘K</span> 隨時開啟搜尋</>} />
      ) : (
        <>
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
