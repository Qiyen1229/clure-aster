/**
 * 帳戶頁（Tab 1）：分段「錢包｜投資」。
 * 錢包：淨資產卡（資產 − 負債，外幣以匯率換算主幣別）、依類型分組、排序、封存、信用卡本期應繳。
 * 投資：階段 4 實作（股票投資組合）。
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Account } from '@/db/types';
import { ACCOUNT_TYPES, creditCardStatement, installmentReserved, reorderAccounts } from '@/db/repo/accounts';
import { creditAvailability } from '@/domain/creditcard';
import { resolveRate } from '@/services/fx';
import { convertMinor } from '@/domain/money';
import { useAccounts } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { AccountSheet } from './AccountSheet';
import { lazy, Suspense } from 'react';
import { usePortfolio } from '@/services/portfolio';

const InvestTab = lazy(() => import('../invest/InvestTab'));

export default function AccountsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'invest' ? 'invest' : 'wallet';
  const { all, loading } = useAccounts(true);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [sorting, setSorting] = useState(false);
  const base = useSettings((s) => s.baseCurrency);
  const navigate = useNavigate();
  const pf = usePortfolio();

  const rates = useLiveQuery(async () => new Map((await db.exchange_rates.toArray()).map((r) => [`${r.base}>${r.quote}`, r])), []);

  const visible = all.filter((a) => (showArchived ? true : !a.archived));
  const toBase = (a: Account) => {
    if (a.currency === base) return a.balanceMinor;
    const r = rates ? resolveRate(rates, a.currency, base) : null;
    return r ? convertMinor(a.balanceMinor, a.currency, base, r) : null;
  };
  const worth = useMemo(() => {
    let assets = 0, liabilities = 0, missing = false;
    for (const a of all) {
      if (a.archived || !a.includeInNetWorth) continue;
      const v = toBase(a);
      if (v === null) { missing = true; continue; }
      if (v >= 0) assets += v; else liabilities += -v;
    }
    const invest = pf?.marketValueBase ?? 0;
    assets += invest;
    return { assets, liabilities, net: assets - liabilities, missing, invest };
  }, [all, rates, base, pf?.marketValueBase]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = ACCOUNT_TYPES.map((t) => ({ ...t, items: visible.filter((a) => a.type === t.type) })).filter((g) => g.items.length);

  const move = async (a: Account, dir: -1 | 1) => {
    const ordered = [...all].sort((x, y) => x.sort - y.sort);
    const i = ordered.findIndex((x) => x.id === a.id);
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    await reorderAccounts(ordered.map((x) => x.id));
  };

  return (
    <main className="page">
      <header className="topbar">
        <div style={{ width: 44 }} />
        <h1>帳戶</h1>
        {tab === 'wallet' ? (
          <button className="icon-btn" aria-label="新增帳戶" onClick={() => setEditing('new')}><Icon name="plus" /></button>
        ) : <div style={{ width: 44 }} />}
      </header>

      <Segmented value={tab} ariaLabel="帳戶分類"
        onChange={(v) => { params.set('tab', v); setParams(params, { replace: true }); }}
        options={[{ value: 'wallet', label: '錢包' }, { value: 'invest', label: '投資' }]} />

      {tab === 'invest' ? (
        <Suspense fallback={<SkeletonRows n={4} />}><InvestTab /></Suspense>
      ) : (
        <>
          <section className="card glass" style={{ marginTop: 16 }} aria-label="淨資產">
            <div className="muted" style={{ fontSize: '0.8rem' }}>淨資產（{base}）</div>
            <div className="hero-num num"><Amount minor={worth.net} currency={base} tone="none" animate /></div>
            <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: '0.85rem' }}>
              <span className="muted">資產 <Amount minor={worth.assets} currency={base} tone="pos" /></span>
              <span className="muted">負債 <Amount minor={worth.liabilities} currency={base} tone="neg" /></span>
              {worth.invest > 0 && <span className="muted">投資 <Amount minor={worth.invest} currency={base} tone="none" /></span>}
            </div>
            {worth.missing && <p className="muted" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>⚠️ 部分外幣帳戶缺少匯率，未計入。連網後會自動更新。</p>}
          </section>

          {loading ? <SkeletonRows /> : all.length === 0 ? (
            <EmptyState emoji="👛" title="還沒有帳戶" text="先建立一個帳戶（現金、銀行、信用卡…），記帳時就能選擇從哪裡付款。"
              action={<button className="btn small" onClick={() => setEditing('new')}>新增帳戶</button>} />
          ) : (
            groups.map((g) => (
              <section key={g.type}>
                <div className="section-title">{g.icon} {g.label}</div>
                <div className="list">
                  {g.items.map((a) => (
                    <div key={a.id} style={{ position: 'relative' }}>
                      <button className="row with-icon" onClick={() => (sorting ? undefined : navigate(`/accounts/${a.id}`))}>
                        <span className="cat-icon" style={{ ['--c' as string]: a.color }} aria-hidden="true">{a.icon}</span>
                        <div className="row-main">
                          <div className="row-title">{a.name}{a.archived ? '（已封存）' : ''}</div>
                          <div className="row-sub">{a.currency}{!a.includeInNetWorth ? ' · 不計入淨資產' : ''}{a.type === 'credit' && a.credit ? <CreditSub account={a} /> : null}</div>
                        </div>
                        <Amount minor={a.balanceMinor} currency={a.currency} tone={a.balanceMinor < 0 ? 'neg' : 'none'} className="num" />
                        {!sorting && <Icon name="chevronR" className="row-chev" />}
                      </button>
                      {sorting && (
                        <div style={{ position: 'absolute', right: 8, top: 0, bottom: 0, display: 'flex', alignItems: 'center', background: 'var(--surface)' }}>
                          <button className="icon-btn plain" aria-label={`${a.name} 上移`} onClick={() => void move(a, -1)}><Icon name="up" /></button>
                          <button className="icon-btn plain" aria-label={`${a.name} 下移`} onClick={() => void move(a, 1)}><Icon name="down" /></button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}

          {all.length > 0 && (
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button className="btn secondary small" onClick={() => setSorting((s) => !s)}>{sorting ? '完成排序' : '排序'}</button>
              <button className="btn secondary small" onClick={() => setShowArchived((s) => !s)}>{showArchived ? '隱藏封存' : '顯示封存'}</button>
            </div>
          )}
        </>
      )}

      <AccountSheet open={editing !== null} onClose={() => setEditing(null)} account={editing && editing !== 'new' ? editing : undefined} />
    </main>
  );
}

function CreditSub({ account }: { account: Account }) {
  const st = useLiveQuery(() => creditCardStatement(account), [account.id, account.balanceMinor]);
  const reserved = useLiveQuery(() => installmentReserved(account.id), [account.id, account.balanceMinor]);
  if (!st || !account.credit) return null;
  const a = creditAvailability(account.credit.limitMinor, account.balanceMinor, st.unbilledMinor, reserved ?? 0);
  return <> · 應繳 <Amount minor={Math.max(0, st.statementMinor)} currency={account.currency} tone="none" />（{st.cycle.dueDate.slice(5).replace('-', '/')}）· 可用 <Amount minor={a.availableMinor} currency={account.currency} tone="none" opts={{ compact: true }} /></>;
}

export function AccountDetailPage() {
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const account = useLiveQuery(() => db.accounts.get(id), [id]);
  const [editing, setEditing] = useState(false);
  const st = useLiveQuery(() => (account?.credit ? creditCardStatement(account) : Promise.resolve(null)), [account?.id, account?.balanceMinor]);
  const reserved = useLiveQuery(() => (account?.credit ? installmentReserved(account.id) : Promise.resolve(0)), [account?.id, account?.balanceMinor]);
  const openAdd = useUI((s) => s.openAdd);
  const avail = account?.credit && st ? creditAvailability(account.credit.limitMinor, account.balanceMinor, st.unbilledMinor, reserved ?? 0) : null;

  if (account === undefined) return <main className="page"><SkeletonRows /></main>;
  if (!account) return <main className="page"><EmptyState emoji="🤔" title="找不到這個帳戶" action={<button className="btn small" onClick={() => navigate('/accounts')}>回帳戶列表</button>} /></main>;

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>{account.name}</h1>
        <button className="icon-btn" aria-label="編輯帳戶" onClick={() => setEditing(true)}><Icon name="edit" /></button>
      </header>
      <section className="card glass" style={{ textAlign: 'center' }}>
        <span className="cat-icon lg" style={{ ['--c' as string]: account.color, margin: '0 auto 8px' }}>{account.icon}</span>
        <div className="muted" style={{ fontSize: '0.8rem' }}>{account.type === 'credit' ? '目前欠款' : '目前餘額'}</div>
        <div className="hero-num num"><Amount minor={account.type === 'credit' ? -account.balanceMinor : account.balanceMinor} currency={account.currency} tone="none" animate /></div>
        {account.credit && st && avail && (
          <div style={{ marginTop: 14, textAlign: 'left' }} aria-label="信用額度">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="muted" style={{ fontSize: '0.8rem' }}>剩餘可用額度</span>
              <b className="num" style={{ fontSize: '1.2rem', color: avail.availableMinor < 0 ? 'var(--danger)' : undefined }}><Amount minor={avail.availableMinor} currency={account.currency} tone="none" /></b>
            </div>
            {/* 額度佔用：已出帳未繳｜未出帳｜分期圈存｜可用 */}
            <div className="credit-bar" role="img" aria-label={`額度使用 ${Math.round(avail.usagePct)}%`}>
              {[
                { v: avail.billedUnpaidMinor, c: 'var(--danger)' },
                { v: avail.unbilledMinor, c: 'var(--warning)' },
                { v: avail.installmentReservedMinor, c: 'var(--accent)' },
              ].map((x, i) => <i key={i} style={{ width: `${Math.min(100, (x.v / Math.max(1, account.credit!.limitMinor)) * 100)}%`, background: x.c }} />)}
            </div>
            <div className="stat-grid" style={{ marginTop: 10 }}>
              <div className="stat"><div className="k"><span className="dot" style={{ background: 'var(--danger)' }} />已出帳未繳</div><div className="v num"><Amount minor={avail.billedUnpaidMinor} currency={account.currency} tone="none" /></div></div>
              <div className="stat"><div className="k"><span className="dot" style={{ background: 'var(--warning)' }} />未出帳</div><div className="v num"><Amount minor={avail.unbilledMinor} currency={account.currency} tone="none" /></div></div>
              <div className="stat"><div className="k"><span className="dot" style={{ background: 'var(--accent)' }} />分期未到期</div><div className="v num"><Amount minor={avail.installmentReservedMinor} currency={account.currency} tone="none" /></div></div>
              <div className="stat"><div className="k">總額度</div><div className="v num"><Amount minor={account.credit.limitMinor} currency={account.currency} tone="none" /></div></div>
              <div className="stat"><div className="k">使用率</div><div className="v num" style={{ color: avail.usagePct >= 80 ? 'var(--danger)' : undefined }}>{avail.usagePct.toFixed(1)}%</div></div>
              <div className="stat"><div className="k">本期應繳</div><div className="v num"><Amount minor={Math.max(0, st.statementMinor)} currency={account.currency} tone="none" /></div></div>
            </div>
          </div>
        )}
        {account.credit && st && (
          <p className="muted" style={{ fontSize: '0.78rem', margin: '10px 0 0' }}>
            帳單週期 {st.cycle.lastStatement.start.slice(5)} ~ {st.cycle.lastStatement.end.slice(5)}，繳款截止 {st.cycle.dueDate}
          </p>
        )}
      </section>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn tinted small" style={{ flex: 1 }} onClick={() => openAdd({ mode: 'expense', accountId: account.id })}>記一筆</button>
        <button className="btn tinted small" style={{ flex: 1 }} onClick={() => openAdd({ mode: 'transfer', accountId: account.type === 'credit' ? undefined : account.id, toAccountId: account.type === 'credit' ? account.id : undefined })}>
          {account.type === 'credit' ? '繳卡費' : '轉帳'}
        </button>
        <button className="btn tinted small" style={{ flex: 1 }} onClick={() => openAdd({ mode: 'adjust', accountId: account.id })}>調整餘額</button>
      </div>
      <button className="row" style={{ borderRadius: 16 }} onClick={() => navigate(`/ledger?account=${account.id}`)}>
        <Icon name="list" /><span className="row-main">查看此帳戶所有帳目</span><Icon name="chevronR" className="row-chev" />
      </button>
      <AccountSheet open={editing} onClose={() => setEditing(false)} account={account} />
    </main>
  );
}
