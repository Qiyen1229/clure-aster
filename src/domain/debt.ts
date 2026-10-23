/**
 * 分帳／代墊：拆分金額、每人淨額（正數 = 對方欠我；負數 = 我欠對方）。
 */
import type { Debt } from '@/db/types';
import { allocate } from './money';

/** 平均拆分：participants 含自己；回傳每人應付金額（總和 = total） */
export function splitEqually(totalMinor: number, participants: number): number[] {
  return allocate(totalMinor, Array(Math.max(1, participants)).fill(1));
}

export function netByPerson(debts: Pick<Debt, 'personId' | 'direction' | 'amountMinor' | 'settled' | 'deletedAt' | 'currency'>[]) {
  const map = new Map<string, Map<string, number>>(); // person -> currency -> net
  for (const d of debts) {
    if (d.settled || d.deletedAt) continue;
    const byCur = map.get(d.personId) ?? new Map<string, number>();
    byCur.set(d.currency, (byCur.get(d.currency) ?? 0) + (d.direction === 'they_owe_me' ? d.amountMinor : -d.amountMinor));
    map.set(d.personId, byCur);
  }
  return map;
}
