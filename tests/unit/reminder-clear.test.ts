import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { clearReminder } from '@/services/notifications';

const row = (id: string) => ({ id, kind: 'budget' as const, refId: '/', dueAt: 1, done: 0 as const, notifiedAt: 1, title: id, body: '' });

describe('刪除單則通知', () => {
  beforeEach(async () => { await db.reminders.clear(); });
  it('只隱藏那一則並標為已讀，資料列保留（避免同一天又被重新通知）', async () => {
    await db.reminders.bulkPut([row('a'), row('b')]);
    await clearReminder('a');
    const a = await db.reminders.get('a');
    expect(a?.cleared).toBe(1);
    expect(a?.done).toBe(1);
    expect((await db.reminders.get('b'))?.cleared).toBeUndefined();
    const visible = await db.reminders.filter((r) => !r.cleared).toArray();
    expect(visible.map((r) => r.id)).toEqual(['b']);
  });
});
