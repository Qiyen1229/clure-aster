/**
 * 首頁收件匣：隨時核對自動記帳送來的待確認項目。
 * 一眼看到前幾筆（來源、金額、是否可疑），可直接「記帳」或「略過」；複雜的（看不懂金額、疑似重複）點進收件匣處理。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts } from '@/app/hooks';
import { formatMoney, toMinor } from '@/domain/money';
import { shortDate } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { AUTH_ENABLED } from '@/stores/auth';
import { snackUndo, useUI } from '@/stores/ui';
import { useInboxCount } from '@/services/inboxCount';
import type { InboxEntry } from '@/services/inbox';
import { Icon } from '@/ui/Icon';

const SHOW = 3;
const snack = (text: string) => useUI.getState().showSnack({ text });

export default function HomeInbox() {
  const navigate = useNavigate();
  const count = useInboxCount((s) => s.n);
  const { map: accMap } = useAccounts();
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayKey();

  const reload = useCallback(async () => {
    try {
      const m = await import('@/services/inbox');
      setEntries(await m.loadInbox());
    } catch {
      setEntries([]);
    }
  }, []);
  useEffect(() => {
    if (AUTH_ENABLED) void reload();
  }, [reload, count]);

  if (!AUTH_ENABLED) return null;

  const book = async (e: InboxEntry) => {
    setBusy(true);
    try {
      const [{ bookInboxEntries }, { deleteTransactions, deleteTransfers }] = await Promise.all([
        import('@/services/inbox'),
        import('@/db/repo/ledger'),
      ]);
      const r = await bookInboxEntries([e]);
      snackUndo(`已記下 ${r.count} 筆`, async () => {
        if (r.txIds.length) await deleteTransactions(r.txIds);
        if (r.transferIds.length) await deleteTransfers(r.transferIds);
      });
      await reload();
    } catch (err) {
      snack((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const skip = async (e: InboxEntry) => {
    setBusy(true);
    try {
      const { ackInbox } = await import('@/services/inbox');
      await ackInbox([e.item.id]);
      setEntries((l) => l?.filter((x) => x.item.id !== e.item.id) ?? null);
    } catch (err) {
      snack((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const list = entries ?? [];
  const shown = list.slice(0, SHOW);

  return (
    <section className="home-inbox" aria-label="收件匣">
      <button type="button" className="home-inbox-head" onClick={() => navigate('/inbox')}>
        <span>📥 收件匣{list.length ? `（${list.length} 筆待確認）` : ''}</span>
        <span className="muted home-inbox-more">{list.length ? '全部查看' : '沒有待確認'}<Icon name="chevronR" size={14} /></span>
      </button>
      {shown.length > 0 && (
        <div className="list">
          {shown.map((e) => {
            const d = e.drafts[0];
            const acc = d ? accMap.get(d.accountId) : undefined;
            const cur = d ? d.currency ?? acc?.currency ?? 'TWD' : 'TWD';
            const simple = !!d && e.drafts.length === 1 && e.dup?.level !== 'strong';
            const title = d?.note || e.item.merchant || e.item.text.slice(0, 30) || '（沒有內容）';
            return (
              <div key={e.item.id} className="row inbox-row">
                <span className="row-main">
                  <span className="row-title">{title}</span>
                  <span className="row-sub" style={{ whiteSpace: 'normal' }}>
                    {d ? `${shortDate(d.date, today)} · ${acc?.name ?? '?'}` : '看不懂金額，請點進去處理'}
                    {e.review ? ' · ⚠️ LINE 聊天，請確認' : e.dup ? ' · ⚠️ 可能重複' : ''}
                  </span>
                </span>
                {d && <span className={`num ${d.kind === 'income' ? 'pos' : 'neg'}`}>{formatMoney(toMinor(d.amount, cur), cur)}</span>}
                <span className="inbox-actions">
                  {simple ? (
                    <button className="pill accent-pill" disabled={busy} onClick={() => void book(e)}>記帳</button>
                  ) : (
                    <button className="pill accent-pill" onClick={() => navigate('/inbox')}>處理</button>
                  )}
                  <button className="pill" disabled={busy} onClick={() => void skip(e)}>略過</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
