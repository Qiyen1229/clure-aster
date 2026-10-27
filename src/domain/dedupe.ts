/**
 * 自動記帳來源去重：Apple Pay、銀行簡訊、電子發票、手動記帳常常是同一次消費。
 * 「同金額＋同幣別＋日期相差 1 天內」是候選；同一天且商家相近或同一帳戶算「很可能重複」（strong），
 * 其餘只是提醒（weak）。只用來提示，不會偷偷刪除任何帳目。
 */
import { fromDateKey } from './period';

export interface DupCandidate {
  id: string;
  date: string;
  amountMinor: number;
  currency: string;
  accountId?: string;
  /** 商家、備註（比對店名用） */
  text: string;
}

export interface DupProbe {
  date: string;
  amountMinor: number;
  currency: string;
  accountId?: string;
  text: string;
}

export interface DupHit { id: string; level: 'strong' | 'weak' }

export function dayGap(a: string, b: string): number {
  return Math.abs(Math.round((fromDateKey(a).getTime() - fromDateKey(b).getTime()) / 86_400_000));
}

const NOISE = /[\s\d.,，。:：;；()（）\[\]「」\-_/\\#*＊·・]|nt\$|twd|台幣|新台幣|元|刷卡|消費|交易|付款|支付|行動支付|apple\s*pay/gi;

/** 比對用的店名：去掉空白、數字、標點與「刷卡」「消費」等通用字 */
export function normalizeShop(s: string): string {
  return s.toLowerCase().replace(NOISE, '');
}

/** 兩段文字的店名相近：其中一個包含另一個，或共用連續 2 個字以上 */
export function shopSimilar(a: string, b: string): boolean {
  const x = normalizeShop(a);
  const y = normalizeShop(b);
  if (x.length < 2 || y.length < 2) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  for (let i = 0; i + 2 <= short.length; i++) if (long.includes(short.slice(i, i + 2))) return true;
  return false;
}

/** 在已有的帳目裡找最像的一筆；沒有就回傳 null */
export function findDuplicate(probe: DupProbe, existing: DupCandidate[]): DupHit | null {
  let best: { hit: DupHit; rank: number } | null = null;
  for (const c of existing) {
    if (c.amountMinor !== probe.amountMinor || c.currency !== probe.currency) continue;
    const gap = dayGap(c.date, probe.date);
    if (gap > 1) continue;
    const sameShop = shopSimilar(c.text, probe.text);
    const sameAcc = !!probe.accountId && c.accountId === probe.accountId;
    const strong = gap === 0 && (sameShop || sameAcc);
    const rank = (strong ? 4 : 0) + (sameShop ? 2 : 0) + (sameAcc ? 1 : 0) + (gap === 0 ? 0.5 : 0);
    if (!best || rank > best.rank) best = { hit: { id: c.id, level: strong ? 'strong' : 'weak' }, rank };
  }
  return best?.hit ?? null;
}
