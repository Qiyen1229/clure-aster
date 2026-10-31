/**
 * 統一發票自動對獎：
 * - 中獎號碼：財政部 RSS（經報價代理），快取在本機 12 小時，離線時沿用快取
 * - 用帳目上的發票號碼（`invoiceNo`）對該期所有支出，找出中獎的發票
 * - 「記入中獎收入」＝新增一筆收入（分類「中獎」，帶同一個發票號碼）；有這筆收入就視為已記入，所以跨裝置同步也不會重複
 * - 開啟 App 時背景檢查，領獎期間內有尚未記入的中獎發票就通知
 */
import { db } from '@/db/schema';
import { addTransaction } from '@/db/repo/ledger';
import type { Transaction } from '@/db/types';
import { todayKey } from '@/domain/period';
import { drawSchedule, matchInvoice, parsePrizeRss, periodRange, type PrizeDraw, type PrizeHit } from '@/domain/invoice-prize';
import { notify } from './notifications';
import { getText } from './quotes/http';
import { useSettings } from '@/stores/settings';

const FEED = 'https://invoice.etax.nat.gov.tw/invoice.xml';
const FRESH_MS = 12 * 3600_000;

interface DrawCache { at: number; draws: PrizeDraw[] }

/** 取得近幾期的中獎號碼；force=true 強制重抓。失敗時沿用快取，連快取都沒有才丟錯 */
export async function loadDraws(opts: { force?: boolean } = {}): Promise<PrizeDraw[]> {
  const cached = (await db.meta.get('invoiceDraws'))?.value as DrawCache | undefined;
  if (cached && !opts.force && Date.now() - cached.at < FRESH_MS) return withExtras(cached.draws);
  try {
    const draws = parsePrizeRss(await getText(FEED, { retries: 1 }));
    if (!draws.length) throw new Error('讀不到中獎號碼（格式可能變了）');
    await db.meta.put({ key: 'invoiceDraws', value: { at: Date.now(), draws } });
    return withExtras(draws);
  } catch (e) {
    if (cached) return withExtras(cached.draws);
    throw e;
  }
}

/** 使用者自己補的增開六獎（財政部有時另行公布）：{ '2026-07': ['123'] } */
async function extras(): Promise<Record<string, string[]>> {
  return ((await db.meta.get('invoiceExtraSixth'))?.value as Record<string, string[]> | undefined) ?? {};
}
export async function setExtraSixth(period: string, list: string[]) {
  const all = await extras();
  await db.meta.put({ key: 'invoiceExtraSixth', value: { ...all, [period]: list } });
}
async function withExtras(draws: PrizeDraw[]): Promise<PrizeDraw[]> {
  const all = await extras();
  return draws.map((d) => ({ ...d, extraSixth: [...new Set([...d.extraSixth, ...(all[d.period] ?? [])])] }));
}

export interface PrizeEntry {
  number: string;
  tx: Transaction;
  hit: PrizeHit | null;
  /** 已經記過這張發票的中獎收入 */
  claimed: boolean;
}
export interface PeriodResult {
  draw: PrizeDraw;
  checked: number;
  entries: PrizeEntry[];
  /** 中獎的（依獎金大到小） */
  winners: PrizeEntry[];
  totalMinor: number;
  unclaimedMinor: number;
  schedule: ReturnType<typeof drawSchedule>;
  /** 領獎期間：before 還沒開始、open 進行中、over 已過期 */
  claimState: 'before' | 'open' | 'over';
}

/** 用某一期的中獎號碼，對該期所有帶發票號碼的支出 */
export async function checkPeriod(draw: PrizeDraw): Promise<PeriodResult> {
  const { start, end } = periodRange(draw.period);
  const rows = await db.transactions.where('date').between(start, end, true, true).filter((t) => !t.deletedAt && !!t.invoiceNo).toArray();
  // 中獎收入記在「領獎當天」，不在該期的日期範圍內，所以用發票號碼另外查
  const claimedNos = new Set(
    (await db.transactions.where('invoiceNo').anyOf(rows.filter((t) => t.type === 'expense').map((t) => t.invoiceNo!)).toArray())
      .filter((t) => !t.deletedAt && t.type === 'income').map((t) => t.invoiceNo!),
  );
  const seen = new Set<string>();
  const entries: PrizeEntry[] = [];
  for (const tx of rows) {
    if (tx.type !== 'expense' || seen.has(tx.invoiceNo!)) continue;
    seen.add(tx.invoiceNo!);
    entries.push({ number: tx.invoiceNo!, tx, hit: matchInvoice(tx.invoiceNo!, draw), claimed: claimedNos.has(tx.invoiceNo!) });
  }
  const winners = entries.filter((e) => e.hit).sort((a, b) => b.hit!.amount - a.hit!.amount);
  const sum = (list: PrizeEntry[]) => list.reduce((s, e) => s + e.hit!.amount, 0) * 100;
  const schedule = drawSchedule(draw.period);
  const today = todayKey();
  return {
    draw, checked: entries.length, entries, winners,
    totalMinor: sum(winners), unclaimedMinor: sum(winners.filter((w) => !w.claimed)), schedule,
    claimState: today < schedule.claimFrom ? 'before' : today > schedule.claimTo ? 'over' : 'open',
  };
}

async function prizeCategoryId(): Promise<string> {
  const cats = await db.categories.toArray();
  const inc = cats.filter((c) => c.kind === 'income' && !c.archived && !c.system);
  return (inc.find((c) => c.id === 'inc-lottery') ?? inc.find((c) => c.name.includes('中獎')) ?? inc.find((c) => c.id === 'inc-other_inc') ?? inc[0])?.id ?? '';
}

/** 把一張中獎發票記成「中獎」收入；記到發票預設帳戶（沒設定就用原本那張發票的帳戶） */
export async function claimPrize(entry: PrizeEntry): Promise<Transaction> {
  if (!entry.hit) throw new Error('這張發票沒有中獎');
  if (entry.claimed) throw new Error('這張發票已經記過中獎收入');
  const accId = useSettings.getState().einvoice.defaultAccountId || entry.tx.accountId;
  const acc = (await db.accounts.get(accId)) ?? (await db.accounts.get(entry.tx.accountId));
  if (!acc) throw new Error('找不到可以入帳的帳戶，請先在電子發票設定預設帳戶');
  const categoryId = await prizeCategoryId();
  if (!categoryId) throw new Error('找不到收入分類');
  return addTransaction({
    type: 'income', accountId: acc.id, categoryId, amountMinor: entry.hit.amount * 100, currency: 'TWD',
    date: todayKey(), ts: Date.now(), invoiceNo: entry.number,
    note: `統一發票中獎（${entry.hit.name}）${entry.number}`,
  });
}

/** 手動輸入發票號碼對獎（紙本發票沒記帳時）：只回傳結果，不寫入 */
export function checkNumber(number: string, draw: PrizeDraw): PrizeHit | null {
  return matchInvoice(number, draw);
}

/** 開啟 App 時：領獎期間內有尚未記入的中獎發票就通知（每一期只通知一次） */
export async function checkPrizesOnStartup(): Promise<number> {
  const draws = await loadDraws();
  let winners = 0;
  for (const draw of draws.slice(0, 3)) {
    const r = await checkPeriod(draw);
    if (r.claimState !== 'open' || !r.unclaimedMinor) continue;
    const n = r.winners.filter((w) => !w.claimed).length;
    winners += n;
    await notify('🎉 統一發票中獎了！', `${draw.label}有 ${n} 張發票中獎，共 $${(r.unclaimedMinor / 100).toLocaleString()}；領獎到 ${r.schedule.claimTo}`, '/settings/invoice/prize', 'invoice', `invoice-prize:${draw.period}:${n}`);
  }
  return winners;
}
