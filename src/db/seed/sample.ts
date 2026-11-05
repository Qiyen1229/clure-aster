/**
 * 範例資料：全部標記 isSample=true，可在設定頁一鍵清除，不影響使用者自己的資料。
 * 產生最近 90 天的日常帳目（固定亂數種子，每次結果相同）。
 */
import { db } from '../schema';
import { addAccount } from '../repo/accounts';
import { addTransaction, addTransfer } from '../repo/ledger';
import { addDurable } from '../repo/durables';
import { addDays, todayKey } from '@/domain/period';
import { recomputeBalances } from '../repo/accounts';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const DAILY: [string, number, number, string][] = [
  // [分類, 最小金額, 最大金額, 備註]
  ['exp-food-breakfast', 45, 120, '早餐'],
  ['exp-food-lunch', 90, 220, '午餐'],
  ['exp-food-dinner', 120, 380, '晚餐'],
  ['exp-food-drink', 45, 85, '手搖飲'],
  ['exp-transport-mrt', 20, 60, '捷運'],
  ['exp-shopping-daily', 60, 450, '全聯'],
  ['exp-entertainment-movie', 280, 600, '電影'],
  ['exp-transport-taxi', 150, 420, 'Uber'],
];

export async function loadSampleData(): Promise<void> {
  const base = { includeInNetWorth: true, currency: 'TWD', isSample: true } as const;
  const cash = await addAccount({ ...base, name: '零用金', icon: '💵', color: '#30D158', type: 'cash', initialBalanceMinor: 3200_00, isLiability: false });
  const bank = await addAccount({ ...base, name: '薪轉帳戶', icon: '🏦', color: '#0A84FF', type: 'bank', initialBalanceMinor: 186000_00, isLiability: false });
  const card = await addAccount({
    ...base, name: '玉山 Pi 卡', icon: '💳', color: '#FF375F', type: 'credit', initialBalanceMinor: 0, isLiability: true,
    credit: { limitMinor: 120000_00, statementDay: 20, dueDay: 5 },
  });
  await addAccount({ ...base, name: '悠遊卡', icon: '🎫', color: '#FFD60A', type: 'stored', initialBalanceMinor: 480_00, isLiability: false });
  await addAccount({ ...base, name: '元大證券', icon: '📈', color: '#FF453A', type: 'brokerage', initialBalanceMinor: 50000_00, isLiability: false });

  const r = rng(20261010);
  const today = todayKey();
  let lastNetflix = '';
  for (let i = 0; i < 90 && !lastNetflix; i++) { const d = addDays(today, -i); if (d.slice(8) === '12') lastNetflix = d; }
  for (let i = 89; i >= 0; i--) {
    const date = addDays(today, -i);
    const n = 1 + Math.floor(r() * 4);
    for (let j = 0; j < n; j++) {
      const [cat, min, max, note] = DAILY[Math.floor(r() * DAILY.length)];
      const amount = Math.round(min + r() * (max - min));
      const acc = r() < 0.55 ? cash.id : card.id;
      await addTransaction({
        type: 'expense', accountId: acc, categoryId: cat, amountMinor: amount * 100, currency: 'TWD',
        date, ts: new Date(`${date}T${String(8 + j * 4).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00`).getTime(),
        note, isSample: true,
      });
    }
    const day = Number(date.slice(8));
    if (day === 5) {
      await addTransaction({
        type: 'income', accountId: bank.id, categoryId: 'inc-salary-base', amountMinor: 62000_00, currency: 'TWD',
        date, ts: new Date(`${date}T09:00:00`).getTime(), note: '薪資', isSample: true,
      });
      await addTransaction({
        type: 'expense', accountId: bank.id, categoryId: 'exp-housing-rent', amountMinor: 16000_00, currency: 'TWD',
        date, ts: new Date(`${date}T10:00:00`).getTime(), note: '房租', isSample: true,
      });
      await addTransfer({
        fromAccountId: bank.id, toAccountId: cash.id, fromAmountMinor: 8000_00, toAmountMinor: 8000_00, feeMinor: 0,
        date, ts: new Date(`${date}T12:00:00`).getTime(), note: '提款', isSample: true,
      });
    }
    if (day === 12) {
      // Netflix 之前每月 $330、最近一次漲到 $390：載入範例資料後 /insights 馬上能看到「訂閱漲價」
      await addTransaction({
        type: 'expense', accountId: card.id, categoryId: 'exp-subscription-video', amountMinor: (date === lastNetflix ? 390 : 330) * 100, currency: 'TWD',
        date, ts: new Date(`${date}T07:00:00`).getTime(), note: 'Netflix', isSample: true,
      });
    }
  }

  // 範例發票：帶發票號碼的支出，讓「統一發票對獎」頁有東西可對（號碼為虛構）
  const invoiceDates = [addDays(today, -4), addDays(today, -9), addDays(today, -15), addDays(today, -22), addDays(today, -33)];
  const invoiceNos = ['AB12345678', 'CD87654321', 'EF11223344', 'GH55667788', 'JK99001122'];
  for (let i = 0; i < invoiceDates.length; i++) {
    await addTransaction({
      type: 'expense', accountId: card.id, categoryId: 'exp-shopping-daily', amountMinor: (180 + i * 65) * 100, currency: 'TWD',
      date: invoiceDates[i], ts: new Date(`${invoiceDates[i]}T18:30:00`).getTime(), note: '全聯（發票）', invoiceNo: invoiceNos[i], isSample: true,
    });
  }

  // 範例耐用品：一件用幾年的手機、一件追蹤「次數」的公路車（購入帳目一併標為範例，清除範例時一起清掉）
  const phoneDate = addDays(today, -430);
  const phone = await addTransaction({
    type: 'expense', accountId: card.id, categoryId: 'exp-shopping-daily', amountMinor: 36900_00, currency: 'TWD',
    date: phoneDate, ts: new Date(`${phoneDate}T14:00:00`).getTime(), note: 'iPhone 15 Pro', isSample: true,
  });
  await addDurable({ name: 'iPhone 15 Pro', icon: '📱', purchaseDate: phoneDate, costMinor: 36900_00, currency: 'TWD', lifeYears: 3, txId: phone.id });
  const bikeDate = addDays(today, -200);
  const bike = await addTransaction({
    type: 'expense', accountId: bank.id, categoryId: 'exp-shopping-daily', amountMinor: 24800_00, currency: 'TWD',
    date: bikeDate, ts: new Date(`${bikeDate}T11:00:00`).getTime(), note: '公路車', isSample: true,
  });
  await addDurable({ name: '公路車', icon: '🚲', purchaseDate: bikeDate, costMinor: 24800_00, currency: 'TWD', lifeYears: 5, trackUses: true, uses: 46, txId: bike.id });
  await db.durables.toCollection().filter((d) => d.txId === phone.id || d.txId === bike.id).modify({ isSample: true });
}

/** 清除所有範例資料（帳目、轉帳、帳戶），並重算受影響帳戶餘額 */
export async function clearSampleData(): Promise<number> {
  let removed = 0;
  await db.transaction('rw', db.transactions, db.transfers, db.accounts, db.attachments, db.durables, async () => {
    const txs = await db.transactions.filter((t) => !!t.isSample).primaryKeys();
    // 範例耐用品（或購入帳目是範例的耐用品）一併清除，不留孤兒
    const txSet = new Set(txs as string[]);
    await db.durables.filter((d) => !!d.isSample || (!!d.txId && txSet.has(d.txId))).delete();
    const trs = await db.transfers.filter((t) => !!t.isSample).primaryKeys();
    await db.transactions.bulkDelete(txs);
    await db.transfers.bulkDelete(trs);
    await db.attachments.where('transactionId').anyOf(txs).delete();
    const accs = await db.accounts.filter((a) => !!a.isSample).primaryKeys();
    // 若使用者在範例帳戶記了自己的帳，保留該帳戶（只取消範例標記）
    for (const id of accs) {
      const used = (await db.transactions.where('accountId').equals(id).count())
        + (await db.transfers.where('fromAccountId').equals(id).count())
        + (await db.transfers.where('toAccountId').equals(id).count());
      if (used) await db.accounts.update(id, { isSample: false });
      else await db.accounts.delete(id);
    }
    removed = txs.length + trs.length;
  });
  await recomputeBalances(true);
  return removed;
}

export async function hasSampleData(): Promise<boolean> {
  return (await db.accounts.filter((a) => !!a.isSample).count()) > 0;
}
