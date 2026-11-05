/** 異常偵測／預算預警的快取讀取（很輕）。首頁只讀這個，不必載入整個偵測引擎（domain/anomaly 等），偵測在閒置時才載入執行 */
import { db } from '@/db/schema';
import type { Finding } from '@/domain/anomaly';
import type { BudgetWarning } from '@/domain/budgetwarn';

export interface InsightsSnapshot {
  at: number;
  txCount: number;
  findings: Finding[];
  warnings: BudgetWarning[];
}

export const CACHE_KEY = 'insights.cache';

export async function loadSnapshot(): Promise<InsightsSnapshot | null> {
  return ((await db.meta.get(CACHE_KEY).catch(() => undefined))?.value as InsightsSnapshot | undefined) ?? null;
}
