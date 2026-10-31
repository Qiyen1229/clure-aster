/**
 * 資金流向桑基圖的資料轉換（純函式）：錢從哪裡來、流到哪裡去。
 *
 *   收入來源（各收入分類）→「總收入」→ 必要支出／非必要支出／投資買進／借出還款／淨儲蓄 → 各主分類 →（子分類）
 *   支出多於收入時，左邊多一條「動用存款」補上差額，整張圖流量守恆。
 *   淨儲蓄再依「各帳戶本期淨流入」分配到帳戶。
 * 金額一律用主幣別最小單位、分帳只算我的份額（statAmount）；餘額調整與標記不計入統計的帳目不算；轉帳不是收支，不在圖裡。
 */
import type { Account, Category, Transaction } from '@/db/types';
import { countsInStats, statAmount } from './ledger';

export interface SankeyNode { id: string; label: string; color?: string; column: number }
export interface SankeyLink { source: string; target: string; value: number }
export interface SankeyModel {
  nodes: SankeyNode[];
  links: SankeyLink[];
  income: number;
  expense: number;
  investing: number;
  debtOut: number;
  /** 淨儲蓄（正）；支出多於收入時為 0 */
  saving: number;
  /** 動用存款（超支的差額） */
  deficit: number;
  empty: boolean;
}

/** 預設「必要支出」的主分類（其餘算非必要）；使用者可在圖表上自行調整 */
export const DEFAULT_ESSENTIAL_MAIN_IDS = ['exp-food', 'exp-housing', 'exp-transport', 'exp-medical', 'exp-insurance', 'exp-tax', 'exp-education', 'exp-family'];

export interface SankeyOptions {
  essentialMainIds: ReadonlySet<string>;
  /** main：到主分類；sub：主分類再展開到子分類（每個主分類最多 topSubs 個，其餘合併成「其他」） */
  depth: 'main' | 'sub';
  topSubs?: number;
}

const COLOR = { pool: '#0A84FF', essential: '#5E9CF5', discretionary: '#FF9F0A', investing: '#FF453A', debt: '#8E8E93', saving: '#30D158', deficit: '#FF453A', income: '#30D158' };

const mainIdOf = (c: Category | undefined, id: string) => (c?.parentId ? c.parentId : id);

export function buildSankey(txs: Iterable<Transaction>, cats: Map<string, Category>, accounts: Map<string, Account>, opts: SankeyOptions): SankeyModel {
  const topSubs = opts.topSubs ?? 4;
  const incomeBy = new Map<string, number>(); // 來源節點 id → 金額
  const incomeLabel = new Map<string, { label: string; color?: string }>();
  // group → main → sub → 金額
  const out: Record<'essential' | 'discretionary' | 'investing' | 'debt', Map<string, Map<string, number>>> = {
    essential: new Map(), discretionary: new Map(), investing: new Map(), debt: new Map(),
  };
  const accNet = new Map<string, number>();
  const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  for (const t of txs) {
    if (!countsInStats(t)) continue;
    const v = statAmount(t);
    if (v <= 0) continue;
    const c = cats.get(t.categoryId);
    if (t.type === 'income') {
      const main = mainIdOf(c, t.categoryId);
      const mc = cats.get(main);
      const id = `i:${main}`;
      add(incomeBy, id, v);
      incomeLabel.set(id, { label: mc?.name ?? '其他收入', color: mc?.color });
      add(accNet, t.accountId, v);
    } else {
      add(accNet, t.accountId, -v);
      const sys = c?.system;
      const main = mainIdOf(c, t.categoryId);
      const group: keyof typeof out = sys === 'stock_buy' ? 'investing' : sys === 'debt_out' ? 'debt'
        : opts.essentialMainIds.has(main) ? 'essential' : 'discretionary';
      const mm = out[group];
      const subs = mm.get(main) ?? new Map<string, number>();
      add(subs, t.categoryId === main ? '' : t.categoryId, v);
      mm.set(main, subs);
    }
  }

  const sum = (m: Map<string, Map<string, number>>) => [...m.values()].reduce((s, subs) => s + [...subs.values()].reduce((a, b) => a + b, 0), 0);
  const income = [...incomeBy.values()].reduce((a, b) => a + b, 0);
  const essential = sum(out.essential), discretionary = sum(out.discretionary), investing = sum(out.investing), debtOut = sum(out.debt);
  const outflow = essential + discretionary + investing + debtOut;
  const saving = Math.max(0, income - outflow);
  const deficit = Math.max(0, outflow - income);
  const expense = essential + discretionary;

  const nodes = new Map<string, SankeyNode>();
  const links: SankeyLink[] = [];
  const node = (id: string, label: string, column: number, color?: string) => { if (!nodes.has(id)) nodes.set(id, { id, label, color, column }); };
  const link = (source: string, target: string, value: number) => { if (value > 0) links.push({ source, target, value }); };

  // 左：收入來源（與動用存款）→ 總收入池
  for (const [id, v] of [...incomeBy].sort((a, b) => b[1] - a[1])) {
    const l = incomeLabel.get(id)!;
    node(id, l.label, 0, l.color ?? COLOR.income);
    link(id, 'pool', v);
  }
  if (deficit > 0) { node('deficit', '動用存款', 0, COLOR.deficit); link('deficit', 'pool', deficit); }
  const poolTotal = income + deficit;
  if (poolTotal === 0) return { nodes: [], links: [], income, expense, investing, debtOut, saving, deficit, empty: true };
  node('pool', '總收入', 1, COLOR.pool);

  const GROUPS: { key: keyof typeof out; id: string; label: string; color: string }[] = [
    { key: 'essential', id: 'g:essential', label: '必要支出', color: COLOR.essential },
    { key: 'discretionary', id: 'g:discretionary', label: '非必要支出', color: COLOR.discretionary },
    { key: 'investing', id: 'g:investing', label: '投資買進', color: COLOR.investing },
    { key: 'debt', id: 'g:debt', label: '借出／還款', color: COLOR.debt },
  ];
  for (const g of GROUPS) {
    const mm = out[g.key];
    const total = sum(mm);
    if (!total) continue;
    node(g.id, g.label, 2, g.color);
    link('pool', g.id, total);
    for (const [main, subs] of [...mm].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
      const mc = cats.get(main);
      const mTotal = [...subs.values()].reduce((a, b) => a + b, 0);
      const mid = `m:${main}`;
      node(mid, mc?.name ?? '未分類', 3, mc?.color);
      link(g.id, mid, mTotal);
      const real = [...subs].filter(([k]) => k !== '').sort((a, b) => b[1] - a[1]);
      if (opts.depth === 'sub' && real.length >= 2) {
        const shown = real.slice(0, topSubs);
        const rest = mTotal - shown.reduce((s, [, v]) => s + v, 0);
        for (const [sid, v] of shown) { const sc = cats.get(sid); node(`s:${sid}`, sc?.name ?? '未分類', 4, sc?.color ?? mc?.color); link(mid, `s:${sid}`, v); }
        if (rest > 0) { node(`s:${main}:rest`, '其他', 4, mc?.color); link(mid, `s:${main}:rest`, rest); }
      }
    }
  }

  if (saving > 0) {
    node('g:saving', '淨儲蓄', 2, COLOR.saving);
    link('pool', 'g:saving', saving);
    // 依各帳戶本期淨流入（只算為正的）分配；沒有任何帳戶為正就直接停在「淨儲蓄」
    const pos = [...accNet].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const posSum = pos.reduce((s, [, v]) => s + v, 0);
    if (posSum > 0) {
      let left = saving;
      pos.forEach(([accId, v], i) => {
        const share = i === pos.length - 1 ? left : Math.round((saving * v) / posSum);
        left -= share;
        const a = accounts.get(accId);
        node(`a:${accId}`, a ? `${a.icon ? `${a.icon} ` : ''}${a.name}` : '帳戶', 3, COLOR.saving);
        link('g:saving', `a:${accId}`, Math.max(0, share));
      });
    }
  }

  return { nodes: [...nodes.values()], links: links.filter((l) => l.value > 0), income, expense, investing, debtOut, saving, deficit, empty: false };
}
