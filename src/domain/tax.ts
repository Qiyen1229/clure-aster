/**
 * 台灣個人投資所得稅務彙總（估算，僅供參考；實際以財政部公告與申報系統為準）。
 *
 * 國內股利（上市櫃、興櫃）：
 *   - 合併計稅：股利併入綜合所得，按邊際稅率課稅，並享 8.5% 可抵減稅額（每戶上限 8 萬元）
 *   - 分開計稅：單一稅率 28%
 *   - 二代健保補充保費：單次股利 ≥ 2 萬元扣 2.11%（已於股利紀錄中）
 * 海外所得（美股、港股）：現金股利（毛額）＋ 當年度已實現證券交易損益（同年度盈虧可互抵，淨損不計）
 *   - 全年海外所得未達 100 萬元免計入基本所得額
 *   - 基本所得額 ＝ 綜合所得淨額 ＋ 海外所得（及其他項目）；扣除免稅額後 × 20% 為基本稅額，高於一般所得稅額時需補繳差額
 * 金額一律以「元」（主單位）計算。級距與免稅額為預設值，可在畫面上調整。
 */

export interface TaxParams {
  /** 綜合所得淨額（不含股利），元；用於估算邊際稅率與基本稅額 */
  netIncome: number;
  brackets: { upTo: number; rate: number }[];
  dividendCreditRate: number;
  dividendCreditCap: number;
  separateRate: number;
  overseasThreshold: number;
  amtExemption: number;
  amtRate: number;
}

/** 預設值（114 年申報 113 年度所得適用；之後年度請依公告調整） */
export const DEFAULT_TAX_PARAMS: TaxParams = {
  netIncome: 0,
  brackets: [
    { upTo: 590_000, rate: 0.05 },
    { upTo: 1_330_000, rate: 0.12 },
    { upTo: 2_660_000, rate: 0.2 },
    { upTo: 4_980_000, rate: 0.3 },
    { upTo: Infinity, rate: 0.4 },
  ],
  dividendCreditRate: 0.085,
  dividendCreditCap: 80_000,
  separateRate: 0.28,
  overseasThreshold: 1_000_000,
  amtExemption: 7_500_000,
  amtRate: 0.2,
};

/** 累進稅額 */
export function progressiveTax(income: number, brackets: TaxParams['brackets']): number {
  let tax = 0, prev = 0;
  for (const b of brackets) {
    if (income <= prev) break;
    tax += (Math.min(income, b.upTo) - prev) * b.rate;
    prev = b.upTo;
  }
  return Math.round(tax);
}

export interface InvestIncome {
  /** 國內現金股利毛額 */
  domesticDividend: number;
  /** 二代健保補充保費（已扣） */
  nhi: number;
  /** 海外現金股利毛額 */
  foreignDividend: number;
  /** 海外股利已被扣繳的稅（例如美股 30%） */
  foreignWithholding: number;
  /** 海外已實現證券交易損益（可為負） */
  foreignRealized: number;
  /** 國內已實現損益（證所稅停徵，僅供參考） */
  domesticRealized: number;
}

export interface TaxSummary {
  combined: { tax: number; credit: number; net: number };
  separate: { tax: number };
  /** 股利課稅方式建議 */
  better: 'combined' | 'separate';
  saving: number;
  overseasIncome: number;
  overseasIncluded: boolean;
  basicIncome: number;
  regularTax: number;
  basicTax: number;
  /** 預估需補繳的基本稅額（已扣除可扣抵的國外已繳稅額） */
  amtDue: number;
}

export function summarizeTax(inc: InvestIncome, p: TaxParams): TaxSummary {
  const d = inc.domesticDividend;
  // 合併計稅：股利造成的增加稅額 − 可抵減稅額（可退稅，因此可為負）
  const baseTax = progressiveTax(p.netIncome, p.brackets);
  const withDiv = progressiveTax(p.netIncome + d, p.brackets);
  const credit = Math.min(Math.round(d * p.dividendCreditRate), p.dividendCreditCap);
  const combinedNet = withDiv - baseTax - credit;
  const separateTax = Math.round(d * p.separateRate);
  const better = combinedNet <= separateTax ? 'combined' : 'separate';
  const overseasIncome = inc.foreignDividend + Math.max(0, inc.foreignRealized);
  const overseasIncluded = overseasIncome >= p.overseasThreshold;
  // 一般所得稅額：依建議的股利課稅方式
  const regularTax = better === 'combined' ? withDiv - credit : baseTax + separateTax;
  const basicIncome = p.netIncome + (better === 'combined' ? d : 0) + (overseasIncluded ? overseasIncome : 0);
  const basicTax = Math.max(0, Math.round((basicIncome - p.amtExemption) * p.amtRate));
  // 國外已繳稅額可扣抵（上限為海外所得造成的基本稅額增加部分，這裡簡化為不超過差額）
  const gap = Math.max(0, basicTax - Math.max(0, regularTax));
  const amtDue = overseasIncluded ? Math.max(0, gap - inc.foreignWithholding) : 0;
  return {
    combined: { tax: withDiv - baseTax, credit, net: combinedNet },
    separate: { tax: separateTax },
    better,
    saving: Math.abs(separateTax - combinedNet),
    overseasIncome,
    overseasIncluded,
    basicIncome,
    regularTax: Math.max(0, regularTax),
    basicTax,
    amtDue,
  };
}
