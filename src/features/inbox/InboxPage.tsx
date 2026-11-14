/**
 * 自動記帳收件匣：
 * ① 預計扣款：週期帳目的待確認 + 看起來是固定扣款、預計日到了的項目
 * ② 待確認：捷徑送來的交易、通知、Siri 一句話 → 一鍵記帳、編輯後記帳、略過
 * （iPhone 捷徑設定已獨立至「設定」→「加入 iPhone 捷徑」）
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts, useCategories } from '@/app/hooks';
import { formatMoney, fromMinor, toMinor } from '@/domain/money';
import { shortDate } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { deleteTransactions, deleteTransfers } from '@/db/repo/ledger';
import {
  ackInbox, bookInboxEntries, mergeDuplicate, loadInbox, SOURCE_LABEL, useInboxCount,
  type InboxEntry,
} from '@/services/inbox';
import { aiEnabledLocally, aiParseText } from '@/services/ai';
import { fallbackAccount, resolveDraft } from '@/services/quickentry';
import { snackUndo, useUI } from '@/stores/ui';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { AiMark, CatIcon, Icon } from '@/ui/Icon';
import { bookForecast, confirmRulePending, loadForecast, registerForecast, skipForecast, skipRulePending, type ForecastData } from '@/services/forecast';
import type { ForecastItem } from '@/domain/forecast';

const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });

export default function InboxPage() {
  const navigate = useNavigate();
  const { map: accMap } = useAccounts();
  const { map: catMap } = useCategories();
  const count = useInboxCount((s) => s.n);
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const today = todayKey();

  // 預計扣款：週期帳目的待確認 + 看起來是固定扣款、預計日到了的項目（本機推算）
  const [fc, setFc] = useState<ForecastData | null>(null);
  const loadFc = useCallback(() => loadForecast().then(setFc, () => setFc({ rules: [], predicted: [] })), []);
  useEffect(() => { void loadFc(); }, [loadFc]);
  const fcRun = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await loadFc(); } catch (e) { snack((e as Error).message); } finally { setBusy(false); }
  };
  const bookFc = (p: ForecastItem) => fcRun(async () => {
    const id = await bookForecast(p);
    snackUndo(`已記下 ${p.name} ${formatMoney(p.amountMinor, p.currency)}`, async () => { await deleteTransactions([id]); await loadFc(); });
  });
  const editFc = (p: ForecastItem) => useUI.getState().openAdd({
    mode: 'expense', amount: fromMinor(p.amountMinor, p.currency).toString(), date: p.dueDate, accountId: p.accountId, categoryId: p.categoryId, note: p.name,
  });
  const fcCount = (fc?.rules.length ?? 0) + (fc?.predicted.length ?? 0);

  const reload = useCallback(async () => {
    try { setEntries(await loadInbox()); setError(''); } catch (e) { setError((e as Error).message); setEntries([]); }
  }, []);
  useEffect(() => { void reload(); }, [reload, count]);

  // 「全部記帳」不含很可能重複的：那些請一則一則確認
  const ready = entries?.filter((e) => e.drafts.length && e.dup?.level !== 'strong' && !e.review) ?? [];

  const book = async (list: InboxEntry[]) => {
    setBusy(true);
    try {
      const r = await bookInboxEntries(list);
      snackUndo(`已記下 ${r.count} 筆${r.skipped ? `（${r.skipped} 筆已在其他裝置處理）` : ''}`, async () => {
        if (r.txIds.length) await deleteTransactions(r.txIds);
        if (r.transferIds.length) await deleteTransfers(r.transferIds);
      });
      await reload();
    } catch (e) { snack((e as Error).message); } finally { setBusy(false); }
  };

  const merge = async (e: InboxEntry) => {
    try {
      if (await mergeDuplicate(e)) snack('已合併，沒有重複記帳');
      await reload();
    } catch (err) { snack((err as Error).message); }
  };

  /** 規則看不懂的簡訊／通知：請 AI 解析成草稿（扣 1 點額度）。解析結果只改在畫面上，確認記帳才會寫入帳本 */
  const [aiBusyId, setAiBusyId] = useState<number | null>(null);
  const aiParse = async (e: InboxEntry) => {
    setAiBusyId(e.item.id);
    try {
      const { drafts } = await aiParseText((e.item.text || e.item.merchant).trim());
      if (!drafts.length) { snack('Cilo 也看不出金額，請手動記'); return; }
      const fb = await fallbackAccount();
      const list = await Promise.all(drafts.map((d) => resolveDraft(d, fb)));
      setEntries((l) => l?.map((x) => (x.item.id === e.item.id ? { ...x, drafts: list } : x)) ?? null);
      snack('AI 已解析，確認後按「記帳」');
    } catch (err) { snack((err as Error).message); } finally { setAiBusyId(null); }
  };
  const skip = async (e: InboxEntry) => {
    await ackInbox([e.item.id]).catch((err) => snack((err as Error).message));
    setEntries((l) => l?.filter((x) => x.item.id !== e.item.id) ?? null);
  };

  const edit = (e: InboxEntry) => {
    const d = e.drafts[0];
    const base = { inboxId: String(e.item.id), inboxCard: e.item.card || undefined };
    if (e.drafts.length > 1) useUI.getState().openAdd({ ...base, quickText: e.item.text });
    else if (d) {
      useUI.getState().openAdd({
        ...base, mode: d.kind, amount: String(d.amount), date: d.date, accountId: d.accountId, toAccountId: d.toAccountId,
        categoryId: d.categoryId, note: d.note, tagIds: d.tagIds.length ? d.tagIds : undefined, merchant: e.item.merchant || undefined,
      });
    } else useUI.getState().openAdd({ ...base, note: (e.item.merchant || e.item.text).slice(0, 200) });
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>收件匣</h1>
        <button className="icon-btn" aria-label="自動記帳白名單" title="自動記帳白名單" onClick={() => navigate('/settings/inbox-whitelist')}><Icon name="shieldCheck" /></button>
        <button className="icon-btn" aria-label="重新整理" onClick={() => void reload()}><Icon name="repeat" /></button>
      </header>

      {fcCount > 0 && (
        <>
          <div className="section-title">預計扣款（{fcCount}）</div>
          <div className="list">
            {fc?.rules.map((it) => {
              const t = it.rule.template;
              const cur = t.currency ?? 'TWD';
              const c = t.categoryId ? catMap.get(t.categoryId) : undefined;
              return (
                <div key={it.id} className="row inbox-row">
                  <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={it.rule.kind === 'subscription' ? 'repeat' : c?.icon ?? 'repeat'} size={16} /></span>
                  <span className="row-main">
                    <span className="row-title">{it.rule.name}</span>
                    <span className="row-sub">🔁 {shortDate(it.date, today)} · 週期帳目 · {accMap.get(t.accountId ?? '')?.name ?? '?'}</span>
                  </span>
                  <span className="num neg">{formatMoney(t.amountMinor ?? 0, cur)}</span>
                  <span className="inbox-actions">
                    <button className="pill accent-pill" disabled={busy} onClick={() => void fcRun(() => confirmRulePending(it))}>確認入帳</button>
                    <button className="pill" disabled={busy} onClick={() => void fcRun(() => skipRulePending(it))}>略過</button>
                  </span>
                </div>
              );
            })}
            {fc?.predicted.map((p) => {
              const c = catMap.get(p.categoryId);
              return (
                <div key={p.id} className="row inbox-row">
                  <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={c?.icon ?? 'sparkles'} size={16} /></span>
                  <span className="row-main">
                    <span className="row-title">{p.name}</span>
                    <span className="row-sub" style={{ whiteSpace: 'normal' }}>
                      🔮 預計 {shortDate(p.dueDate, today)}{p.lateDays > 0 ? `（已過 ${p.lateDays} 天）` : ''} · {p.period === 'week' ? '每週' : p.period === 'month' ? '每月' : '每年'}固定 · {accMap.get(p.accountId)?.name ?? '?'}
                    </span>
                  </span>
                  <span className="num neg">{formatMoney(p.amountMinor, p.currency)}</span>
                  <span className="inbox-actions">
                    <button className="pill accent-pill" disabled={busy} onClick={() => void bookFc(p)}>記帳</button>
                    <button className="pill" disabled={busy} onClick={() => editFc(p)}>編輯</button>
                    <button className="pill" disabled={busy} onClick={() => void fcRun(() => registerForecast(p))} title="之後每期到了固定提醒你確認">登記成週期</button>
                    <button className="pill" disabled={busy} onClick={() => void fcRun(() => skipForecast(p.id))}>略過</button>
                  </span>
                </div>
              );
            })}
          </div>
          {fc && fc.predicted.length > 0 && <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 4px 0' }}>🔮 是從你的記帳紀錄推算的（連續幾期金額差不多），不一定真的扣了；已經手動記過的會自動消失。</p>}
        </>
      )}

      <div className="section-title">待確認{entries?.length ? `（${entries.length}）` : ''}</div>
      {error && <div className="card"><p style={{ margin: 0 }}>收件匣暫時讀不到：{error}</p></div>}
      {entries === null ? <SkeletonRows n={2} /> : entries.length === 0 ? (
        <EmptyState emoji="📭" title="收件匣是空的" text="捷徑送來的消費通知與預計扣款會出現在這裡核對記帳。" />
      ) : (
        <>
          <div className="list">
            {entries.map((e) => {
              const src = SOURCE_LABEL[e.item.source] ?? SOURCE_LABEL.other;
              if (!e.drafts.length) {
                return (
                  <div key={e.item.id} className="row inbox-row">
                    <span className="cat-icon sm" aria-hidden="true"><CatIcon icon={src.icon} size={16} /></span>
                    <span className="row-main">
                      <span className="row-title">{e.item.merchant || e.item.text.slice(0, 40) || '（沒有內容）'}</span>
                      <span className="row-sub" style={{ whiteSpace: 'normal' }}>{src.label} · 看不懂金額，請手動記</span>
                    </span>
                    <span className="inbox-actions">
                      {aiEnabledLocally() && (e.item.text || e.item.merchant) && <button className="pill accent-pill" disabled={aiBusyId === e.item.id} onClick={() => void aiParse(e)}>{aiBusyId === e.item.id ? '解析中…' : <><AiMark /> Cilo 解析</>}</button>}
                      <button className="pill" onClick={() => edit(e)}>手動記</button>
                      <button className="pill" onClick={() => void skip(e)} aria-label="略過">略過</button>
                    </span>
                  </div>
                );
              }
              return e.drafts.map((d, i) => {
                const c = d.categoryId ? catMap.get(d.categoryId) : undefined;
                const acc = accMap.get(d.accountId);
                const cur = d.currency ?? acc?.currency ?? 'TWD';
                return (
                  <div key={`${e.item.id}-${i}`} className="row inbox-row">
                    <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={d.kind === 'transfer' ? 'repeat' : c?.icon ?? src.icon} size={16} /></span>
                    <span className="row-main">
                      <span className="row-title">{d.note || c?.name || src.label}</span>
                      <span className="row-sub">{src.icon} {shortDate(d.date, today)} · {c?.name ?? '轉帳'} · {acc?.name ?? '?'}{e.item.card ? `（${e.item.card}）` : ''}</span>
                    </span>
                    <span className={`num ${d.kind === 'income' ? 'pos' : 'neg'}`}>{formatMoney(toMinor(d.amount, cur), cur)}</span>
                    {i === e.drafts.length - 1 && e.review && (
                      <p className="inbox-dup strong" role="note">⚠️ {e.review}</p>
                    )}
                    {i === e.drafts.length - 1 && e.dup && (
                      <p className={`inbox-dup ${e.dup.level}`} role="note">
                        {e.dup.level === 'strong' ? '⚠️ 很可能重複：' : 'ℹ️ 金額相同：'}
                        {e.dup.from === 'ledger' ? `帳本裡已有 ${e.dup.label}` : `和 ${e.dup.label}是同一次消費？`}
                      </p>
                    )}
                    {i === e.drafts.length - 1 && (
                      <span className="inbox-actions">
                        {e.dup?.level === 'strong' ? (
                          <>
                            <button className="pill accent-pill" onClick={() => void merge(e)}>合併（不重複記）</button>
                            <button className="pill" disabled={busy} onClick={() => void book([e])}>仍要記帳</button>
                            <button className="pill" onClick={() => edit(e)}>編輯</button>
                          </>
                        ) : (
                          <>
                            <button className="pill accent-pill" disabled={busy} onClick={() => void book([e])}>記帳</button>
                            {e.dup && <button className="pill" onClick={() => void merge(e)}>合併</button>}
                            <button className="pill" onClick={() => edit(e)}>編輯</button>
                            <button className="pill" onClick={() => void skip(e)}>略過</button>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                );
              });
            })}
          </div>
          {ready.length > 1 && <button className="btn" disabled={busy} onClick={() => void book(ready)}>全部記帳（{ready.reduce((n, e) => n + e.drafts.length, 0)} 筆）</button>}
        </>
      )}
    </main>
  );
}
