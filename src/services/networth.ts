/**
 * 淨資產歷史：
 * - 有每日快照的日期：使用快照（含投資市值）
 * - 更早的月份：由目前帳戶餘額「倒推」各月底餘額（減去之後發生的帳目／轉帳），換算為主幣別
 */
import { db } from '@/db/schema';
import { txEffect } from '@/domain/ledger';
import { convertMinor } from '@/domain/money';
import { addMonths, todayKey } from '@/domain/period';
import { resolveRate } from './fx';
import { getSetting } from '@/db/repo/settings';

export interface NetPoint { date: string; netWorth: number; invest: number; source: 'snapshot' | 'rebuild' }

function monthEnd(key: string): string {
  const d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function netWorthSeries(months = 12): Promise<NetPoint[]> {
  const today = todayKey();
  const [accounts, rates, base, snaps] = await Promise.all([
    db.accounts.toArray(), db.exchange_rates.toArray(), getSetting('baseCurrency'), db.portfolio_snapshots.toArray(),
  ]);
  const map = new Map(rates.map((r) => [`${r.base}>${r.quote}`, r]));
  const included = accounts.filter((a) => a.includeInNetWorth && !a.archived);
  const rate = new Map(included.map((a) => [a.id, a.currency === base ? '1' : resolveRate(map, a.currency, base)?.toString() ?? null]));
  const start = addMonths(today, -months).slice(0, 8) + '01';
  const [txs, trs] = await Promise.all([
    db.transactions.where('date').above(start).toArray(),
    db.transfers.where('date').above(start).toArray(),
  ]);
  // 由今天往回：每個月底餘額 = 目前餘額 − 該月底之後的變動
  const deltas: { date: string; acc: string; v: number }[] = [];
  for (const t of txs) if (!t.deletedAt) deltas.push({ date: t.date, acc: t.accountId, v: txEffect(t) });
  for (const t of trs) if (!t.deletedAt) { deltas.push({ date: t.date, acc: t.fromAccountId, v: -t.fromAmountMinor }, { date: t.date, acc: t.toAccountId, v: t.toAmountMinor }); }
  const points: NetPoint[] = [];
  const snapByDate = new Map(snaps.map((s) => [s.date, s]));
  for (let i = months; i >= 0; i--) {
    const end = i === 0 ? today : monthEnd(addMonths(today, -i));
    const snap = snapByDate.get(end) ?? (i === 0 ? snaps.filter((s) => s.date <= end).pop() : undefined);
    if (snap && snap.date === end) { points.push({ date: end, netWorth: snap.netWorthMinor, invest: snap.investMarketValueMinor, source: 'snapshot' }); continue; }
    let total = 0;
    for (const a of included) {
      const r = rate.get(a.id);
      if (!r) continue;
      let bal = a.balanceMinor;
      for (const d of deltas) if (d.acc === a.id && d.date > end) bal -= d.v;
      total += convertMinor(bal, a.currency, base, r);
    }
    // 投資市值取該日以前最近的快照
    const inv = snaps.filter((s) => s.date <= end).pop()?.investMarketValueMinor ?? 0;
    points.push({ date: end, netWorth: total + inv, invest: inv, source: 'rebuild' });
  }
  return points;
}

/** 近 N 天每日快照（投資頁的損益曲線） */
export async function snapshotSeries(days = 365) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.portfolio_snapshots.where('date').aboveOrEqual(from).sortBy('date');
}
