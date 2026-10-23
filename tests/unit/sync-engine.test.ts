/**
 * 同步引擎：兩台「裝置」（兩個獨立 IndexedDB）透過模擬伺服器同步
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openUserDatabase } from '@/db/schema';
import { bootstrap } from '@/db/bootstrap';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, deleteTransactions } from '@/db/repo/ledger';
import { saveSetting, loadSettings } from '@/db/repo/settings';
import { updateCategory } from '@/db/repo/categories';

/** 與後端相同規則的記憶體伺服器（最後寫入者勝、時間相同保留伺服器版本、seq 游標、排除自己的裝置） */
function fakeServer() {
  type Rec = { table: string; key: string; updated_at: number; deleted: boolean; payload: unknown; seq: number; device: string };
  const recs = new Map<string, Rec>();
  let seq = 0;
  const handle = async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x');
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/api/sync/status') return json({ enabled: true, protocol_version: 2, records: recs.size, cursor: seq });
    if (u.pathname === '/api/sync/push') {
      const body = JSON.parse(String(init!.body));
      const rejected: unknown[] = [];
      let accepted = 0;
      for (const c of body.changes) {
        const k = `${c.table}|${c.key}`;
        const cur = recs.get(k);
        if (cur && cur.updated_at >= c.updated_at) { rejected.push({ ...cur }); continue; }
        recs.set(k, { ...c, seq: ++seq, device: body.device_id });
        accepted++;
      }
      return json({ accepted, rejected, cursor: seq });
    }
    if (u.pathname === '/api/sync/pull') {
      const since = Number(u.searchParams.get('since')), dev = u.searchParams.get('device_id');
      const rows = [...recs.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
      return json({ changes: rows.filter((r) => r.device !== dev), cursor: rows.length ? rows.at(-1)!.seq : since, has_more: false });
    }
    return new Response('{}', { status: 404 });
  };
  return { handle, recs };
}

let server: ReturnType<typeof fakeServer>;
let sync: typeof import('@/services/sync');

async function useDevice(name: string) {
  await openUserDatabase(name);
}

describe('跨裝置同步', () => {
  beforeEach(async () => {
    server = fakeServer();
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => server.handle(url, init));
    vi.stubGlobal('document', { cookie: 'csrf_token=t', visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
    sync = await import('@/services/sync');
    for (const n of ['phone', 'laptop']) { await openUserDatabase(n); await db.delete(); }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('手機的帳目、設定、分類修改 → 新電腦登入後全部取得，不會被預設值覆蓋', async () => {
    // 手機：同步功能上線前就有資料
    await useDevice('phone');
    await bootstrap();
    await saveSetting('onboarded', true);
    await saveSetting('baseCurrency', 'JPY');
    await saveSetting('lock', { enabled: true } as never); // 裝置專屬，不應同步
    const acc = await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'JPY', initialBalanceMinor: 10000, includeInNetWorth: true, isLiability: false });
    await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 1200, currency: 'JPY', date: '2026-10-11', ts: 1, note: '拉麵' });
    await new Promise((r) => setTimeout(r, 5));
    await updateCategory('exp-food', { name: '吃飯' });
    await sync.syncNow();
    expect(await db.sync_outbox.count()).toBe(0);

    // 電腦：全新登入（先同步再建立預設值）
    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    const s = await loadSettings();
    expect(s.onboarded).toBe(true);
    expect(s.baseCurrency).toBe('JPY');
    expect(s.lock.enabled).toBe(false);
    expect((await db.transactions.toArray()).map((t) => t.note)).toEqual(['拉麵']);
    expect((await db.accounts.get(acc.id))!.balanceMinor).toBe(10000 - 1200);
    expect((await db.categories.get('exp-food'))!.name).toBe('吃飯');
    // 電腦的預設分類不會蓋掉手機的修改
    await sync.syncNow();
    await useDevice('phone');
    await sync.syncNow();
    expect((await db.categories.get('exp-food'))!.name).toBe('吃飯');
  });

  it('雙向：電腦新增、刪除 → 手機收到；餘額重算', async () => {
    await useDevice('phone');
    await bootstrap();
    const acc = await addAccount({ name: '銀行', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 100000, includeInNetWorth: true, isLiability: false });
    const t1 = await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 5000, currency: 'TWD', date: '2026-10-11', ts: 1, note: '晚餐' });
    await sync.syncNow();

    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    await addTransaction({ type: 'income', accountId: acc.id, categoryId: 'inc-salary', amountMinor: 30000, currency: 'TWD', date: '2026-10-11', ts: 2, note: '獎金' });
    await deleteTransactions([t1.id]);
    await sync.syncNow();

    await useDevice('phone');
    await sync.syncNow();
    const live = (await db.transactions.toArray()).filter((t) => !t.deletedAt).map((t) => t.note);
    expect(live).toEqual(['獎金']);
    expect((await db.accounts.get(acc.id))!.balanceMinor).toBe(130000);
    // 套用遠端變更不會再被排入上傳
    expect(await db.sync_outbox.count()).toBe(0);
  });

  it('同一筆兩邊都改：較晚的修改勝出', async () => {
    await useDevice('phone');
    await bootstrap();
    await sync.syncNow();
    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    await useDevice('phone');
    await updateCategory('exp-food', { name: '手機改的' });
    await new Promise((r) => setTimeout(r, 5));
    await useDevice('laptop');
    await updateCategory('exp-food', { name: '電腦改的（較晚）' });
    await sync.syncNow();
    await useDevice('phone');
    await sync.syncNow(); // 手機的較早修改被拒，改套用伺服器版本
    expect((await db.categories.get('exp-food'))!.name).toBe('電腦改的（較晚）');
  });
});
