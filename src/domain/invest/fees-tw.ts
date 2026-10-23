/**
 * 台股交易成本：
 * - 手續費 = 成交金額 × 0.1425% × 券商折扣，無條件捨去到「元」；未滿最低手續費以最低計（整股預設 20 元、零股預設 1 元）
 * - 證交稅（僅賣出）= 成交金額 × 稅率，無條件捨去到「元」；股票 0.3%、ETF 0.1%、債券 ETF 免徵（2026 年底前）
 * 回傳值皆為 TWD 最小單位（分），即「元 × 100」。
 */
import Decimal from 'decimal.js';

export interface TwFeeConfig {
  feeRateDec: string; // '0.001425'
  discountDec: string; // '0.6' = 六折
  minFee: number; // 元
  oddLotMinFee: number; // 元
  taxStockDec: string; // '0.003'
  taxEtfDec: string; // '0.001'
  taxBondEtfDec?: string; // '0'
}

export const DEFAULT_TW_FEES: TwFeeConfig = {
  feeRateDec: '0.001425', discountDec: '1', minFee: 20, oddLotMinFee: 1, taxStockDec: '0.003', taxEtfDec: '0.001', taxBondEtfDec: '0',
};

export function isOddLot(sharesDec: Decimal.Value, lotSize = 1000): boolean {
  return !new Decimal(sharesDec).mod(lotSize).isZero();
}

/** 成交金額（元，未捨入） */
export function tradeValue(priceDec: Decimal.Value, sharesDec: Decimal.Value): Decimal {
  return new Decimal(priceDec).mul(sharesDec);
}

export function twFee(priceDec: Decimal.Value, sharesDec: Decimal.Value, cfg: TwFeeConfig = DEFAULT_TW_FEES, lotSize = 1000): number {
  const value = tradeValue(priceDec, sharesDec);
  if (value.lte(0)) return 0;
  const raw = value.mul(cfg.feeRateDec).mul(cfg.discountDec).floor();
  const min = isOddLot(sharesDec, lotSize) ? cfg.oddLotMinFee : cfg.minFee;
  return Decimal.max(raw, min).toNumber() * 100;
}

export function twTaxRate(assetType: 'stock' | 'etf' | 'bond_etf', cfg: TwFeeConfig = DEFAULT_TW_FEES, override?: string): string {
  if (override) return override;
  return assetType === 'etf' ? cfg.taxEtfDec : assetType === 'bond_etf' ? cfg.taxBondEtfDec ?? '0' : cfg.taxStockDec;
}

export function twSellTax(priceDec: Decimal.Value, sharesDec: Decimal.Value, taxRateDec: string): number {
  return tradeValue(priceDec, sharesDec).mul(taxRateDec).floor().toNumber() * 100;
}
