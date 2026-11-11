/**
 * 判斷一句話是不是在「要求整理帳本」（批次改分類、設預算、建週期帳目、提前還款試算、建自動分類規則、建存錢目標），
 * 是的話首頁對話框會轉交給操作助手（先預覽、你確認才執行），而不是當成記一筆或問答。
 * 刻意保守：寧可漏掉也不要把一般記帳（「午餐 120」）誤判成操作。
 */
const PATTERNS: RegExp[] = [
  // 批次改分類：「把…改歸類到…」「把所有 Uber 歸到交通」（要再搭配分類字眼，見下）
  /(改(成|為|歸|到)|歸(類)?到|重新分類|統一(分類|歸)|批次)/,
  // 設定或調整預算：「設通勤每月預算 3000」「把飲食預算調成 8000」「飲食預算改成 8000」
  /((設(定)?|建立|新增|幫我(設|建)|調整|調高|調低|調降|提高|降低).{0,12}預算|預算.{0,6}(調(成|為|到|整)?|改(成|為|到)|設(成|為|定)?)\s*\d)/,
  // 建立週期／訂閱：「建立每月 12 號 Netflix 390 的訂閱」
  /(建立|新增|幫我(建|設)).{0,24}(訂閱|週期|定期|固定)/,
  // 提前還款試算
  /(提前還款|提早還款|一次還.{0,8}(房貸|車貸|信貸|學貸|貸款)|多還)/,
  // 建立自動分類規則：「新增自動分類規則」「以後只要有星巴克就自動算飲食」
  /(自動分類規則|(建立|新增|設定).{0,10}規則|以後.{0,16}自動(歸|分|算|記))/,
  // 建立存錢目標：「幫我設一個年底前存 5 萬去日本玩的目標」「新增存錢目標 10 萬」
  /((設(定)?|建立|新增|幫我(設|建)).{0,24}目標|存錢目標)/,
  // v4.1.0 動作圖譜：買進股票、結清欠款、還款（信貸／房貸／卡費）、存進目標、轉帳到某帳戶
  /買(進)?\s*[\d,]+\s*(股|張)/,
  /(結清|還清).{0,12}(欠|借)|(欠|借).{0,10}(結清|還清)|把欠.{0,10}(結清|還清)/,
  /(拿|用|轉|撥|匯).{0,14}還.{0,8}(信貸|房貸|車貸|學貸|貸款|卡費|信用卡)|還.{0,4}(信貸|房貸|車貸|學貸)\s*[\d,]+/,
  /(撥|存|轉|放)(進|入|到).{0,10}目標/,
  /(從|由).{0,10}(轉|匯|撥).{0,6}[\d,]+.{0,6}(到|進|給)/,
  // v4.1.12 刪除與修改已記下的帳目：「刪掉剛剛那筆」「把昨天的午餐刪掉」「剛剛那筆改成 180」「把午餐的金額改成 150」
  /(刪除|刪掉|刪了|刪|移除|砍掉|撤銷)\s*(剛剛|剛才|上一筆|最後一筆|最後那筆|剛記的|剛才記的|昨天|今天|前天|上週|這週|上個月|這個月).{0,16}/,
  /把.{1,30}(刪掉|刪除|移除|砍掉|刪了)$/,
  /(刪除|刪掉|移除|砍掉|刪了|撤銷).{0,24}(那筆|這筆|一筆|帳目|記錄|紀錄|消費)/,
  /(剛剛|剛才|上一筆|最後一筆|最後那筆|那筆|這筆|剛記的|剛才記的).{0,14}(改成|改為|應該是|其實是|算成|歸到|換成|變成|改)/,
  /把.{1,30}的?(金額|備註|日期|帳戶)(改成|改為|改|換成|變成)/,
];
// 「改」需要搭配分類或歸類的語意，單純的「改成」（例如備註）不算
const NEEDS_CATEGORY_WORD = /分類|歸類|歸到|歸入|改歸|類別|都改/;

// 記一筆／操作之後「順便給我看」某張檢視：句子有多個子句、有金額，又要求看財務自由、現金流、稅、花費…
// （純看圖的短句已經在 localView 先被攔截；單純的問句「幫我看今年稅怎麼算」沒有多個子句與金額，不會走到這裡）
const VIEW_ASK = /(給我看|幫我看|顯示|看看|模擬|試算).{0,12}(財務自由|退休|FIRE|現金流|稅|花費|支出)/i;
const MULTI_CLAUSE = /[，,、；;]|順便|然後|再給|再幫|並且/;
const HAS_AMOUNT = /\d|[一二兩三四五六七八九十百千萬]/;

export function looksLikeOperation(text: string): boolean {
  const s = text.trim();
  if (s.length < 6) return false;
  if (/^(?:不要|別|不用|請勿|暫不|先別)/.test(s) || /(?:不要|別|不用|請勿|暫不|先別)\s*(?:刪除|刪掉|改|動|調整|設定|建立|新增|買進|結清|還清|記帳|操作)/.test(s)) return false;
  if (VIEW_ASK.test(s) && MULTI_CLAUSE.test(s) && HAS_AMOUNT.test(s)) return true;
  if (PATTERNS[0].test(s) && NEEDS_CATEGORY_WORD.test(s)) return true;
  return PATTERNS.slice(1).some((p) => p.test(s));
}


// ───────────── 對話即介面：說一個詞就直接出檢視卡（本機判斷，不用 AI、不扣額度） ─────────────

import type { ViewSpec } from './plan';

const CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 「55 歲」「五十五歲」「六十歲」→ 數字；只認 30–80 歲 */
const ageOf = (s: string): number | null => {
  const d = /(\d{2})\s*歲/.exec(s);
  const c = /([三四五六七八])十([一二三四五六七八九])?\s*歲/.exec(s);
  const n = d ? Number(d[1]) : c ? CN[c[1]] * 10 + (c[2] ? CN[c[2]] : 0) : NaN;
  return n >= 30 && n <= 80 ? n : null;
};

/** 「財務自由」「現金流」「稅務」「這個月花費」「如果 55 歲退休」這類短句：直接顯示對應的檢視卡。保守：只認短句，其他交給對話分流 */
export function localView(text: string): ViewSpec | null {
  const s = text.trim().replace(/[？?。！!]/g, '');
  if (s.length < 2 || s.length > 18) return null;
  const lead = '(?:給我|幫我)?(?:看|顯示|打開|開|查)?(?:一下)?(?:我的)?';
  if (new RegExp(`^${lead}(?:財務自由|退休)(?:試算|模擬|狀況)?$`).test(s)) return { kind: 'fire', params: {} };
  if (/^(如果|假如|萬一|若)?.{0,8}歲.{0,4}(退休|財務自由)(會怎樣|怎麼樣|呢|的話)?$/.test(s)) {
    const a = ageOf(s);
    if (a) return { kind: 'fire', params: { retire_age: a } };
  }
  if (new RegExp(`^${lead}(?:現金流|錢夠不夠用)(?:預測)?$`).test(s)) return { kind: 'cashflow', params: {} };
  if (new RegExp(`^${lead}(?:稅務|節稅|二代健保|除息|股利稅)(?:規劃|試算|預警|狀況)?$`).test(s)) return { kind: 'tax', params: {} };
  const m = new RegExp(`^${lead}(這個月|本月|上個月|上月|今年)(?:的)?(?:花費|支出|開銷)(?:分析|狀況)?$`).exec(s);
  if (m) return { kind: 'spending', params: { range: m[1] === '今年' ? 'this_year' : m[1] === '上個月' || m[1] === '上月' ? 'last_month' : 'this_month' } };
  return null;
}

import type { RawStep } from './plan';
import { parseCnNumber, toHalfWidth } from '../nlp-amount';

const LATEST = '(?:剛剛|剛才|上一筆|最後一筆|最後那筆|剛記的|剛剛記的|剛才記的)';
const LEAD = '(?:幫我|請幫我|請|麻煩|可以)?\\s*';
const ACTION_DEL = '(?:刪除|刪掉|刪了|刪|移除|砍掉|撤銷)';
const DEL_LATEST = new RegExp(
  `^${LEAD}(?:把\\s*)?${LATEST}\\s*(?:那筆|這筆|一筆)?\\s*(?:帳|帳目|記錄|紀錄|支出|消費)?\\s*(?:給我)?\\s*${ACTION_DEL}$|^${LEAD}${ACTION_DEL}\\s*(?:把\\s*)?${LATEST}\\s*(?:那筆|這筆|一筆)?\\s*(?:帳|帳目|記錄|紀錄|支出|消費)?$`
);
const EDIT_ACTION = '(?:改成|改為|應該是|其實是|算成|換成|改|歸到|變成|是)';
const EDIT_LATEST = new RegExp(
  `^${LEAD}(?:把\\s*)?${LATEST}\\s*(?:那筆|這筆|一筆)?\\s*(?:的)?\\s*(金額|備註|分類|日期)?\\s*${EDIT_ACTION}\\s*(.+)$`
);

/**
 * 「剛剛那筆」這類不需要 AI 就能看懂的修改／刪除：直接產生操作助手的步驟（走同一套預覽、確認、還原），不扣額度。
 * 其他說法（「把昨天的午餐刪掉」）交給 AI 規劃。
 */
export function localEditPlan(text: string): { summary: string; steps: RawStep[] } | null {
  const s = toHalfWidth(text).trim().replace(/[。.!！]+$/, '');
  if (s.length > 40) return null;
  if (DEL_LATEST.test(s)) return { summary: '刪除剛剛記的那一筆', steps: [{ tool: 'delete_transaction', args: { match: { latest: true } } }] };
  const m = s.match(EDIT_LATEST);
  if (!m) return null;
  const field = m[1];
  const v = m[2].trim().replace(/^(成|為)/, '').replace(/(元|塊|圓)$/, '').trim();
  if (!v) return null;
  const num = /^[\d,]+(?:\.\d+)?$/.test(v) ? Number(v.replace(/,/g, '')) : parseCnNumber(v);
  const set: Record<string, unknown> = {};
  if (field === '備註') set.note = v;
  else if (field === '日期') { const d = v.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!d) return null; set.date = v; }
  else if (field === '分類') set.category = v.replace(/(分類|類別)$/, '');
  else if (field === '金額' || (!field && num !== null && num !== undefined && Number.isFinite(num))) { if (!(num && num > 0)) return null; set.amount = num; }
  else set.category = v.replace(/(分類|類別|這一類|類)$/, '');
  return { summary: '修改剛剛記的那一筆', steps: [{ tool: 'edit_transaction', args: { match: { latest: true }, set } }] };
}
