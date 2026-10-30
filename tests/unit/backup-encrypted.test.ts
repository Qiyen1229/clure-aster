import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { BackupPassphraseError, buildBackup, buildEncryptedBackup, isEncryptedBackup, restoreBackup } from '@/services/backup';


// 備份 service 用到 __APP_VERSION__（Vite 的 define）；測試環境補上
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';

const file = async (b: Blob, name = 'b.json') => new File([await b.text()], name, { type: 'application/json' });

describe('加密備份', () => {
  beforeEach(async () => {
    await db.transactions.clear(); await db.accounts.clear(); await db.categories.clear();
    await db.accounts.add({ id: 'a1', name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 0, balanceMinor: 0, includeInNetWorth: true, isLiability: false, sort: 0, archived: 0, createdAt: 0, updatedAt: 0 } as never);
    await db.transactions.add({ id: 't1', type: 'expense', accountId: 'a1', categoryId: 'c', amountMinor: 12300, currency: 'TWD', accountAmountMinor: 12300, baseAmountMinor: 12300, date: '2026-10-01', ts: 1, note: '機密：醫療費用', tagIds: [], attachmentIds: [], createdAt: 0, updatedAt: 0 } as never);
  });

  it('加密後的檔案看不到任何明文；用正確密碼能完整還原', async () => {
    const enc = await buildEncryptedBackup('correct horse 9', false);
    const text = await enc.text();
    expect(text).not.toContain('機密');
    expect(text).not.toContain('醫療');
    expect(JSON.parse(text)).toMatchObject({ app: 'aster', format: 'encrypted-1', kdf: 'PBKDF2-SHA256', iterations: 310000 });
    const f = await file(enc);
    expect(await isEncryptedBackup(f)).toBe(true);
    await db.transactions.clear();
    const r = await restoreBackup(f, 'replace', 'correct horse 9');
    expect(r.rows).toBeGreaterThan(0);
    expect((await db.transactions.get('t1'))?.note).toBe('機密：醫療費用');
  });

  it('密碼錯誤、沒給密碼、檔案被改過：都不會還原，並回報可理解的訊息', async () => {
    const f = await file(await buildEncryptedBackup('correct horse 9', false));
    await expect(restoreBackup(f, 'merge')).rejects.toMatchObject({ name: 'BackupPassphraseError', needed: true });
    await expect(restoreBackup(f, 'merge', 'wrong password')).rejects.toThrow('密碼不正確');
    const env = JSON.parse(await f.text());
    env.ct = env.ct.slice(0, 40) + (env.ct[40] === 'A' ? 'B' : 'A') + env.ct.slice(41);
    await expect(restoreBackup(new File([JSON.stringify(env)], 'x.json'), 'merge', 'correct horse 9')).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  it('每次加密的鹽與 IV 都不同（同樣內容、同樣密碼，密文也不一樣）', async () => {
    const a = JSON.parse(await (await buildEncryptedBackup('same password 1', false)).text());
    const b = JSON.parse(await (await buildEncryptedBackup('same password 1', false)).text());
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('密碼太短不能加密；惡意檔案的迭代次數太大／太小會被拒絕（避免讓裝置算很久）', async () => {
    await expect(buildEncryptedBackup('short', false)).rejects.toThrow('至少 8');
    const env = JSON.parse(await (await buildEncryptedBackup('long enough pw', false)).text());
    for (const iterations of [1, 99_999_999]) {
      await expect(restoreBackup(new File([JSON.stringify({ ...env, iterations })], 'x.json'), 'merge', 'long enough pw')).rejects.toThrow('格式不正確');
    }
  });

  it('不加密的舊備份檔照樣能還原', async () => {
    const plain = await file(await buildBackup(false));
    expect(await isEncryptedBackup(plain)).toBe(false);
    await db.transactions.clear();
    await restoreBackup(plain, 'replace');
    expect(await db.transactions.count()).toBe(1);
  });
});
