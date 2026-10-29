/**
 * 同步後的重複資料整理。
 *
 * 兩台裝置各自新增了「同一檔股票」（同市場＋代號）或「同名標籤／人」時，兩邊的 id 不同。
 * 以前這些欄位是唯一索引，下載對方的資料會直接寫入失敗，整個同步卡死——投資區塊最容易遇到
 * （兩台裝置都加了 2330，或都把同一檔加進觀察清單）。現在索引不再要求唯一，下載一定寫得進來，
 * 再由這裡決定性地整理：兩台裝置看到同樣的資料會做出同樣的選擇（id 較小的留下），不會互相拉扯。
 *   - 股票：合併到 id 最小的那一筆，買賣、股利、觀察清單、報價快取改指向它
 *   - 觀察清單：同一檔只留一筆
 *   - 標籤、人：同名的後來者改名為「名稱 (2)」，不動既有的引用
 * 這裡的寫入會被同步追蹤（不是 markRemote），所以整理結果也會同步回其他裝置。
 */
import { db } from './schema';
import type { Stock, WatchItem } from './types';

const minId = <T extends { id: string }>(rows: T[]) => rows.reduce((a, b) => (b.id < a.id ? b : a));

export async function reconcileDuplicates(): Promise<{ stocks: number; watchlist: number; renamed: number }> {
  const res = { stocks: 0, watchlist: 0, renamed: 0 };
  await db.transaction('rw', [db.stocks, db.stock_trades, db.dividends, db.watchlist, db.price_cache, db.price_history, db.tags, db.people], async () => {
    // 股票
    const groups = new Map<string, Stock[]>();
    for (const s of await db.stocks.toArray()) {
      const k = `${s.market}|${s.symbol}`;
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const win = minId(rows);
      for (const lose of rows) {
        if (lose.id === win.id) continue;
        await db.stock_trades.where('stockId').equals(lose.id).modify({ stockId: win.id });
        await db.dividends.where('stockId').equals(lose.id).modify({ stockId: win.id });
        await db.watchlist.where('stockId').equals(lose.id).modify({ stockId: win.id });
        await db.price_cache.delete(lose.id);
        await db.price_history.where('stockId').equals(lose.id).delete();
        await db.stocks.delete(lose.id);
        res.stocks++;
      }
    }
    // 觀察清單：同一檔只留 id 最小的一筆
    const byStock = new Map<string, WatchItem[]>();
    for (const w of await db.watchlist.toArray()) byStock.set(w.stockId, [...(byStock.get(w.stockId) ?? []), w]);
    for (const rows of byStock.values()) {
      if (rows.length < 2) continue;
      const win = minId(rows);
      for (const w of rows) if (w.id !== win.id) { await db.watchlist.delete(w.id); res.watchlist++; }
    }
    // 同名標籤、同名的人：後來者改名
    for (const table of [db.tags, db.people] as const) {
      const rows = (await table.toArray()) as { id: string; name: string }[];
      const seen = new Map<string, { id: string; name: string }[]>();
      for (const r of rows) seen.set(r.name, [...(seen.get(r.name) ?? []), r]);
      const taken = new Set(rows.map((r) => r.name));
      for (const [name, list] of seen) {
        if (list.length < 2) continue;
        const win = minId(list);
        for (const r of list.filter((x) => x.id !== win.id).sort((a, b) => (a.id < b.id ? -1 : 1))) {
          let n = 2;
          while (taken.has(`${name} (${n})`)) n++;
          const next = `${name} (${n})`;
          taken.add(next);
          await (table as typeof db.tags).update(r.id, { name: next });
          res.renamed++;
        }
      }
    }
  });
  return res;
}
