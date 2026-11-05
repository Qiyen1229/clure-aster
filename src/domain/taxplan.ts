/**
 * 台灣股利稅務規劃（純函式，金額一律是「元」，與 domain/tax.ts 相同；估算僅供參考）：
 *  1. 即將除息的持股：配息多少、會不會被扣二代健保（單次 ≥ 2 萬，2.11%）、這筆股利對你「合併 vs 分開計稅」的邊際影響
 *  2. 參與除息 vs. 除息前賣出、除息後買回（俗稱棄息）：把差額拆成「省下的稅與補充保費」「多花的交易成本」，
 *     並給出買回價的損益兩平點；價格波動風險無法預測，所以建議偏保守
 *  3. 海外所得控管：離 100 萬（免計入基本所得額）與基本稅額還有多遠、年底前實現虧損（稅損收割）能不能降到門檻以下
 *
 * 邊際稅額的算法：把「這一筆之外的其他股利」固定，比較「有這一筆」與「沒有這一筆」兩種情形下，
 * 全年股利取「合併計稅」與「分開計稅」較省者的稅額差——所以可能是負的（8.5% 抵減大於增加的稅，等於可退稅）。
 */
import { progressiveTax, summarizeTax, type InvestIncome, type TaxParams } from './tax';

export const NHI_THRESHOLD = 20_000;
export const NHI_RATE = 0.0211;
/** 「棄息」至少要多省這個金額、且高於價格風險緩衝，才值得提醒 */
export const SKIP_MIN_ADVANTAGE = 300;
/** 賣出到買回之間價格可能的偏離（以持股市值的比例估算風險緩衝） */
export const SKIP_RISK_RATIO = 0.005;

export interface DivEvent {
  stockId: string;
  symbol: string;
  name: string;
  assetType: 'stock' | 'etf' | 'bond_etf';
  /** 除息日（估算的事件可能是依去年推算的） */
  exDate: string | null;
  payDate: string | null;
  source: 'announced' | 'estimated';
  shares: number;
  perShare: number;
  /** 目前股價（元）；沒有報價時是 0 */
  price: number;
  /** 預計配息毛額（元） */
  gross: number;
}

/** 二代健保補充保費：單次給付 ≥ 2 萬元，全額 × 2.11% */
export const nhiFor = (gross: number): number => (gross >= NHI_THRESHOLD ? Math.round(gross * NHI_RATE) : 0);

/** 全年國內股利取「合併計稅」與「分開計稅」較省者的稅額（可為負＝退稅） */
export function dividendTaxOf(totalDividend: number, p: TaxParams): { tax: number; method: 'combined' | 'separate' } {
  if (totalDividend <= 0) return { tax: 0, method: 'combined' };
  const base = progressiveTax(p.netIncome, p.brackets);
  const combined = progressiveTax(p.netIncome + totalDividend, p.brackets) - base - Math.min(Math.round(totalDividend * p.dividendCreditRate), p.dividendCreditCap);
  const separate = Math.round(totalDividend * p.separateRate);
  return combined <= separate ? { tax: combined, method: 'combined' } : { tax: separate, method: 'separate' };
}

/** 這一筆股利造成的稅額變化（其他股利固定） */
export const incrementalTax = (otherDividend: number, gross: number, p: TaxParams): number =>
  dividendTaxOf(otherDividend + gross, p).tax - dividendTaxOf(otherDividend, p).tax;

/** 邊際稅率（依綜合所得淨額加上全年股利落在哪一級） */
export function marginalRate(income: number, p: TaxParams): number {
  for (const b of p.brackets) if (income <= b.upTo) return b.rate;
  return p.brackets[p.brackets.length - 1].rate;
}

export interface TradeCosts { sellFee: number; sellTax: number; buyFee: number }

export interface DivAnalysis {
  event: DivEvent;
  nhi: number;
  nhiNearMiss: boolean;
  /** 股利造成的稅額變化（負＝可退稅） */
  incTax: number;
  method: 'combined' | 'separate';
  /** 參與除息實拿：配息 − 補充保費 − 增加的稅 */
  joinNet: number;
  /** 抵減額度（8.5%，上限 8 萬）在這筆之前還剩多少 */
  creditRemainingBefore: number;
  /** 棄息（除息前賣出、除息後買回）相對於參與除息的稅後差額；已扣交易成本 */
  skipAdvantage: number | null;
  skipCosts: number | null;
  /** 買回價比「賣價 − 每股股利」高出多少（元/股）以內仍划算 */
  breakEvenPerShare: number | null;
  riskBuffer: number | null;
  recommendation: 'join' | 'consider_skip';
}

/**
 * 分析一筆即將發放的股利。
 * @param otherDividend 同一年度其他國內股利合計（已領＋已公告＋推估，不含這一筆）
 * @param costs 棄息要多付的交易成本（賣出手續費＋證交稅＋買回手續費，元）；沒有報價時給 null
 */
export function analyzeDividend(ev: DivEvent, otherDividend: number, p: TaxParams, costs: TradeCosts | null): DivAnalysis {
  const nhi = nhiFor(ev.gross);
  const incTax = incrementalTax(otherDividend, ev.gross, p);
  const method = dividendTaxOf(otherDividend + ev.gross, p).method;
  const joinNet = ev.gross - nhi - incTax;
  const creditUsed = Math.min(Math.round(otherDividend * p.dividendCreditRate), p.dividendCreditCap);
  let skipAdvantage: number | null = null, skipCosts: number | null = null, breakEven: number | null = null, riskBuffer: number | null = null;
  if (costs && ev.price > 0 && ev.shares > 0) {
    skipCosts = costs.sellFee + costs.sellTax + costs.buyFee;
    // 棄息：配息改以「賣價高於買回價」的價差拿到（台股買賣價差免稅），省下稅與補充保費、多付交易成本
    skipAdvantage = Math.round(nhi + incTax - skipCosts);
    breakEven = skipAdvantage / ev.shares;
    riskBuffer = Math.round(ev.price * ev.shares * SKIP_RISK_RATIO);
  }
  return {
    event: ev, nhi, nhiNearMiss: ev.gross >= NHI_THRESHOLD * 0.8 && ev.gross < NHI_THRESHOLD, incTax, method, joinNet,
    creditRemainingBefore: Math.max(0, p.dividendCreditCap - creditUsed),
    skipAdvantage, skipCosts, breakEvenPerShare: breakEven, riskBuffer,
    recommendation: skipAdvantage !== null && riskBuffer !== null && skipAdvantage > Math.max(SKIP_MIN_ADVANTAGE, riskBuffer) ? 'consider_skip' : 'join',
  };
}

const n = (v: number) => Math.abs(Math.round(v)).toLocaleString('zh-TW');
const md = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : '近期');
/** 持股的白話寫法：≥ 1000 股寫「張」 */
export const sharesText = (s: number) => (s >= 1000 && s % 1000 === 0 ? `${s / 1000} 張` : `${s.toLocaleString('zh-TW')} 股`);

/** 一句話行動建議（新手看得懂；細節數字另外展開） */
export function adviceOf(a: DivAnalysis): { headline: string; tone: 'ok' | 'warn' | 'info' } {
  const e = a.event;
  const who = `您持有的 ${sharesText(e.shares)} ${e.symbol}${e.name ? `（${e.name}）` : ''}`;
  const when = e.source === 'estimated' ? `預計約 ${md(e.exDate)} 除息（依去年推算）` : `將於 ${md(e.exDate)} 除息`;
  const money = `預計配息約 ${n(e.gross)} 元`;
  const nhiPart = a.nhi ? `，會被扣二代健保 ${n(a.nhi)} 元` : '';
  const taxPart = a.incTax < 0
    ? `，合併計稅預估可退稅約 ${n(a.incTax)} 元`
    : a.incTax === 0 ? '，預估不會多繳稅' : `，預估要多繳所得稅約 ${n(a.incTax)} 元`;
  const credit = a.incTax < 0 || a.creditRemainingBefore > 0 ? `（今年股利抵減額度還有 ${n(a.creditRemainingBefore)} 元可用）` : '';
  if (a.recommendation === 'consider_skip' && a.skipAdvantage !== null) {
    return {
      tone: 'info',
      headline: `${who}${when}，${money}${nhiPart}${taxPart}。若除息前賣出、除息後買回，扣掉交易成本約 ${n(a.skipCosts ?? 0)} 元後，預估多保留約 ${n(a.skipAdvantage)} 元——但你要承擔賣出到買回之間的股價波動，而且可能買不回原本的價位，不保證划算。`,
    };
  }
  return { tone: a.nhi ? 'warn' : 'ok', headline: `${who}${when}，${money}${nhiPart}${taxPart}${credit}，建議直接參與除息、不必賣出。` };
}

// ───────────── 海外所得控管 ─────────────

export interface OverseasWatch {
  income: number;
  threshold: number;
  pct: number;
  level: 'safe' | 'near' | 'over';
  /** 距離門檻還有多少（已超過為負） */
  remaining: number;
  amtDue: number;
  basicTaxGap: number;
  /** 年底前把「未實現虧損」實現後的情形（沒有未實現虧損或已實現損益為負就沒有） */
  harvest: null | { lossAvailable: number; newIncome: number; dropsBelowThreshold: boolean; amtSaved: number; realizeNeeded: number };
}

export function overseasWatch(inc: InvestIncome, p: TaxParams, unrealizedLoss: number): OverseasWatch {
  const sum = summarizeTax(inc, p);
  const income = sum.overseasIncome;
  const pct = p.overseasThreshold > 0 ? (income / p.overseasThreshold) * 100 : 0;
  let harvest: OverseasWatch['harvest'] = null;
  if (unrealizedLoss > 0 && inc.foreignRealized > 0) {
    const realizeNeeded = income >= p.overseasThreshold ? Math.min(unrealizedLoss, income - p.overseasThreshold + 1) : 0;
    const after = summarizeTax({ ...inc, foreignRealized: inc.foreignRealized - unrealizedLoss }, p);
    harvest = { lossAvailable: unrealizedLoss, newIncome: after.overseasIncome, dropsBelowThreshold: income >= p.overseasThreshold && after.overseasIncome < p.overseasThreshold, amtSaved: Math.max(0, sum.amtDue - after.amtDue), realizeNeeded };
  }
  return {
    income, threshold: p.overseasThreshold, pct, remaining: p.overseasThreshold - income, level: income >= p.overseasThreshold ? 'over' : pct >= 70 ? 'near' : 'safe',
    amtDue: sum.amtDue, basicTaxGap: Math.max(0, sum.basicTax - sum.regularTax), harvest,
  };
}

export function overseasAdvice(w: OverseasWatch): { headline: string; tone: 'ok' | 'warn' | 'info' } {
  if (w.level === 'safe') return { tone: 'ok', headline: `海外所得目前 ${n(w.income)} 元，距離 100 萬免計入門檻還有 ${n(w.remaining)} 元，暫時不用處理。` };
  if (w.level === 'near') return { tone: 'warn', headline: `海外所得已有 ${n(w.income)} 元（門檻的 ${Math.round(w.pct)}%），再賺 ${n(w.remaining)} 元就會超過 100 萬、要計入基本所得額。年底前賣出海外股票獲利要特別留意。` };
  const h = w.harvest;
  const base = `海外所得 ${n(w.income)} 元，已超過 100 萬門檻，要計入基本所得額${w.amtDue > 0 ? `，預估要補繳基本稅額約 ${n(w.amtDue)} 元` : '（目前估算不需補繳）'}。`;
  if (h?.dropsBelowThreshold) return { tone: 'info', headline: `${base}你的海外持股有 ${n(h.lossAvailable)} 元未實現虧損，年底前賣出實現的話，海外所得會降到 ${n(h.newIncome)} 元（低於門檻）${h.amtSaved > 0 ? `，約可省基本稅額 ${n(h.amtSaved)} 元` : ''}。賣出有交易成本，也等於把虧損部位出場，是否划算請自行評估。` };
  if (h && h.lossAvailable > 0) return { tone: 'info', headline: `${base}你的海外持股有 ${n(h.lossAvailable)} 元未實現虧損，實現後可抵掉部分獲利，但還是會超過門檻。` };
  return { tone: 'warn', headline: base };
}
