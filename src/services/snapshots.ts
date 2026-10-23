/**
 * 每日資產快照：iOS PWA 無法在背景執行，因此「每次開啟 App 時」：
 *  1. 以目前資料寫入今天的快照（盤中多次開啟會覆蓋成最新）
 *  2. 若上次快照到今天之間有缺漏日期，以上一筆快照的數值補齊（標記 backfill）
 * 淨資產 = 計入淨資產的帳戶餘額（換算主幣別）＋ 投資市值。
 */
import { db } from '@/db/schema';
import type { PortfolioSnapshot } from '@/db/types';
import { addDays, todayKey } from '@/domain/period';
import { convertMinor } from '@/domain/money';
import { resolveRate } from './fx';
import { investMarketValueBase } from './portfolio';
import { getSetting } from '@/db/repo/settings';

export async function accountsNetWorth() {
  const [accounts, rates, base] = await Promise.all([db.accounts.toArray(), db.exchange_rates.toArray(), getSetting('baseCurrency')]);
  const map = new Map(rates.map((r) => [`${r.base}>${r.quote}`, r]));
  let assets = 0, liabilities = 0;
  const byAccount: Record<string, number> = {};
  for (const a of accounts) {
    if (a.archived || !a.includeInNetWorth) continue;
    const r = a.currency === base ? '1' : resolveRate(map, a.currency, base);
    if (!r) continue;
    const v = convertMinor(a.balanceMinor, a.currency, base, r);
    byAccount[a.id] = v;
    if (v >= 0) assets += v; else liabilities += -v;
  }
  return { assets, liabilities, byAccount };
}

export async function takeSnapshot(today = todayKey()): Promise<PortfolioSnapshot> {
  const [acc, inv] = await Promise.all([accountsNetWorth(), investMarketValueBase()]);
  const snap: PortfolioSnapshot = {
    date: today,
    assetsMinor: acc.assets + inv.mv,
    liabilitiesMinor: acc.liabilities,
    netWorthMinor: acc.assets + inv.mv - acc.liabilities,
    investMarketValueMinor: inv.mv,
    investCostMinor: inv.cost,
    unrealizedPnlMinor: inv.unrealized,
    realizedPnlCumMinor: inv.realized,
    dividendCumMinor: inv.dividends,
    byAccount: acc.byAccount,
    byStock: inv.byStock,
    filled: 'live',
  };
  // 補齊缺漏日期（最多回補 400 天）
  const last = await db.portfolio_snapshots.where('date').below(today).last();
  if (last) {
    const fills: PortfolioSnapshot[] = [];
    for (let d = addDays(last.date, 1); d < today && fills.length < 400; d = addDays(d, 1)) fills.push({ ...last, date: d, filled: 'backfill' });
    if (fills.length) await db.portfolio_snapshots.bulkPut(fills);
  }
  await db.portfolio_snapshots.put(snap);
  return snap;
}
