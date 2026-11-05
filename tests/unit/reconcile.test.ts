import { describe, expect, it } from 'vitest';
import { reconcile, summarizeReport, type LedgerRow, type StmtRow } from '@/domain/reconcile';

const S = (id: string, date: string, yuan: number, text: string, extra: Partial<StmtRow> = {}): StmtRow => ({ id, date, amountMinor: yuan * 100, kind: 'expense', text, ...extra });
const L = (id: string, date: string, yuan: number, text: string, extra: Partial<LedgerRow> = {}): LedgerRow =>
  ({ id, date, accountMinor: yuan * 100, origMinor: yuan * 100, origCurrency: 'TWD', kind: 'expense', text, ...extra });

describe('對帳引擎', () => {
  it('金額相同、日期差 ≤ 3 天視為吻合；超過 3 天或類型不同不配', () => {
    const r = reconcile(
      [S('s1', '2026-10-10', 120, '全聯'), S('s2', '2026-10-12', 350, '誠品'), S('s3', '2026-10-20', 99, 'Netflix')],
      [L('l1', '2026-10-11', 120, '全聯福利中心'), L('l2', '2026-10-12', 350, '書'), L('l3', '2026-10-27', 99, 'Netflix'), L('l4', '2026-10-20', 99, '退款', { kind: 'income' })], 'TWD');
    expect(r.matched.map((m) => m.stmt.id).sort()).toEqual(['s1', 's2']);
    expect(r.missing.map((x) => x.id)).toEqual(['s3']); // 7 天差、另一筆是收入：都不配
  });

  it('一對一：兩筆同金額的帳單只會各配一筆帳目，多的一筆算漏記', () => {
    const r = reconcile([S('a', '2026-10-10', 100, '早餐'), S('b', '2026-10-11', 100, '早餐')], [L('x', '2026-10-10', 100, '早餐')], 'TWD');
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].stmt.id).toBe('a'); // 同日優先
    expect(r.missing.map((m) => m.id)).toEqual(['b']);
  });

  it('外幣：記帳用預估匯率，實際請款差 NT$42 → 匯差；原幣金額相同就配得上', () => {
    const r = reconcile(
      [S('s', '2026-10-08', 1642, 'AMAZON.COM', { foreignMinor: 5000, foreignCurrency: 'USD' })],
      [L('l', '2026-10-08', 1600, 'Amazon', { origMinor: 5000, origCurrency: 'USD' })], 'TWD');
    expect(r.variances).toHaveLength(1);
    expect(r.variances[0]).toMatchObject({ diffMinor: 4200, reason: 'fx' });
  });

  it('海外交易手續費約 1.5%；店名不像又差很多就不硬配', () => {
    const r = reconcile([S('s', '2026-10-08', 1015, '國外網站')], [L('l', '2026-10-08', 1000, '訂閱')], 'TWD');
    expect(r.variances[0]).toMatchObject({ diffMinor: 1500, reason: 'overseas_fee' });
    const r2 = reconcile([S('s', '2026-10-08', 1040, '甲店')], [L('l', '2026-10-08', 1000, '乙家')], 'TWD');
    expect(r2.variances).toHaveLength(0); // 差 4%、店名不像：不配
    expect(r2.missing).toHaveLength(1);
    expect(r2.extra).toHaveLength(1);
  });

  it('漏記與多記：多記只看帳單涵蓋的日期範圍內', () => {
    const r = reconcile([S('s1', '2026-10-10', 50, '手續費'), S('s2', '2026-10-20', 80, 'A')],
      [L('l2', '2026-10-20', 80, 'A'), L('in', '2026-10-15', 70, '多記的'), L('out', '2026-12-01', 10, '範圍外')], 'TWD');
    expect(r.missing.map((m) => m.id)).toEqual(['s1']);
    expect(r.extra.map((e) => e.id)).toEqual(['in']);
    expect(summarizeReport(r, (m) => `$${m / 100}`)).toContain('1 筆漏記');
  });

  it('淨額合計：收入（退款）抵掉支出', () => {
    const r = reconcile([S('a', '2026-10-10', 100, 'x'), { ...S('b', '2026-10-11', 30, '退款'), kind: 'income' }], [], 'TWD');
    expect(r.stmtTotalMinor).toBe(7000);
  });
});
