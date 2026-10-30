/**
 * 中文一句話解析：帳戶與分類比對（純函式）
 * 從一句話裡找出提到的帳戶（完整名稱或去掉「銀行／卡」的簡稱）與分類。
 */
export interface NlpAccount { id: string; name: string; type?: string }
export interface NlpCategory { id: string; name: string; kind: 'expense' | 'income'; parentId: string }

const ACCOUNT_SUFFIX = /(銀行|帳戶|账户|戶頭|信用卡|金融卡|簽帳卡|卡片|卡|錢包|帳號)$/;

/** 帳戶的比對詞：完整名稱、去掉「銀行／卡／帳戶」的名稱（至少 2 個字） */
function accountTerms(a: NlpAccount): string[] {
  const n = a.name.trim();
  const short = n.replace(ACCOUNT_SUFFIX, '').trim();
  const terms = [n];
  if (short.length >= 2 && short !== n) terms.push(short);
  // 「台新 Richart」「國泰 CUBE 卡」：每個詞也可以單獨稱呼
  for (const w of short.split(/\s+/)) if (w.length >= 2 && w !== short && !ACCOUNT_SUFFIX.test(w)) terms.push(w);
  if (a.type === 'cash') terms.push('現金');
  return terms.map((x) => x.toLowerCase());
}

export interface AccountHit { id: string; index: number; term: string }

/** 依出現位置找出提到的帳戶（同一段文字只算最長的那個詞） */
export function findAccounts(text: string, accounts: NlpAccount[]): AccountHit[] {
  const lower = text.toLowerCase();
  const hits: AccountHit[] = [];
  for (const a of accounts) {
    for (const term of accountTerms(a)) {
      const i = lower.indexOf(term);
      if (i >= 0) hits.push({ id: a.id, index: i, term });
    }
  }
  // 「信用卡」這種泛稱：只有一張信用卡時才對應
  const credits = accounts.filter((a) => a.type === 'credit');
  if (credits.length === 1 && /信用卡|刷卡/.test(text) && !hits.some((h) => h.id === credits[0].id)) {
    hits.push({ id: credits[0].id, index: text.search(/信用卡|刷卡/), term: '' });
  }
  hits.sort((a, b) => a.index - b.index || b.term.length - a.term.length);
  const out: AccountHit[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (out.some((o) => o.id === h.id)) continue;
    if (prev && h.index < prev.index + prev.term.length) continue; // 被較長的詞涵蓋
    out.push(h);
  }
  return out;
}

/**
 * 常見說法 → 分類名稱。使用者的分類可以自己改，所以只在「真的有這個名稱的分類」時才採用，不會憑空捏造。
 * generic：說的就是分類本身（「手搖飲」「晚餐」），認出來後從備註拿掉；
 * 其他是具體的東西或店名（「珍奶」「Uber」「星巴克」），只用來判斷分類，仍然留在備註。
 */
interface Synonym { names: string[]; kind: 'expense' | 'income'; generic: string[]; specific?: string[] }
const SYNONYMS: Synonym[] = [
  { names: ['飲料', '飲品'], kind: 'expense', generic: ['手搖飲', '手搖', '飲料', '飲品', '飲料店'],
    specific: ['珍奶', '珍珠奶茶', '奶茶', '紅茶', '綠茶', '青茶', '烏龍茶', '果汁', '汽水', '可樂', '咖啡', '拿鐵', '美式', '星巴克', '路易莎', '冰沙', '五十嵐', '50嵐', '清心', '可不可', '迷客夏', '麥香'] },
  { names: ['早餐'], kind: 'expense', generic: ['早餐', '早點', '早飯'], specific: ['蛋餅', '飯糰', '吐司', '燒餅', '豆漿', '蘿蔔糕'] },
  { names: ['午餐'], kind: 'expense', generic: ['午餐', '午飯', '中餐'], specific: ['便當', '自助餐'] },
  { names: ['晚餐'], kind: 'expense', generic: ['晚餐', '晚飯'] },
  { names: ['宵夜', '晚餐'], kind: 'expense', generic: ['宵夜', '消夜'] },
  { names: ['點心'], kind: 'expense', generic: ['點心', '零食', '甜點', '下午茶'], specific: ['蛋糕', '餅乾', '冰淇淋', '甜甜圈'] },
  { names: ['食材'], kind: 'expense', generic: ['食材', '買菜', '菜錢'] },
  { names: ['聚餐'], kind: 'expense', generic: ['聚餐', '聚會', '吃飯聚'] },
  { names: ['計程車'], kind: 'expense', generic: ['計程車', '小黃', '叫車'], specific: ['uber', '55688'] },
  { names: ['捷運公車'], kind: 'expense', generic: ['捷運', '公車', '搭車'], specific: ['悠遊卡'] },
  { names: ['高鐵火車'], kind: 'expense', generic: ['高鐵', '台鐵', '火車', '客運'] },
  { names: ['加油'], kind: 'expense', generic: ['加油', '油錢', '汽油'] },
  { names: ['停車'], kind: 'expense', generic: ['停車', '停車費'] },
  { names: ['水電瓦斯'], kind: 'expense', generic: ['水電', '電費', '水費', '瓦斯', '瓦斯費'] },
  { names: ['網路電信'], kind: 'expense', generic: ['網路費', '電信費', '手機費', '電話費', '網路'] },
  { names: ['房租'], kind: 'expense', generic: ['房租', '租金'] },
  { names: ['日用品'], kind: 'expense', generic: ['日用品', '衛生紙', '洗衣精'] },
  { names: ['電影'], kind: 'expense', generic: ['電影', '看電影'] },
  { names: ['運動健身'], kind: 'expense', generic: ['健身房', '健身', '運動'] },
  { names: ['門診'], kind: 'expense', generic: ['看醫生', '掛號', '門診', '診所'] },
  { names: ['藥品'], kind: 'expense', generic: ['藥局', '買藥', '藥品'] },
  { names: ['牙科'], kind: 'expense', generic: ['牙醫', '洗牙', '牙科'] },
  { names: ['美髮'], kind: 'expense', generic: ['剪髮', '理髮', '美髮', '染髮'] },
  { names: ['影音串流'], kind: 'expense', generic: [], specific: ['netflix', 'disney', 'youtube premium', 'hbo'] },
  { names: ['音樂串流'], kind: 'expense', generic: [], specific: ['spotify', 'kkbox', 'apple music'] },
  { names: ['紅白包'], kind: 'expense', generic: ['紅包', '白包', '禮金', '包紅包'] },
  { names: ['請客'], kind: 'expense', generic: ['請客'] },
  { names: ['禮物'], kind: 'expense', generic: ['禮物', '送禮'] },
  { names: ['獸醫'], kind: 'expense', generic: ['獸醫', '看獸醫'] },
  { names: ['薪資', '本薪'], kind: 'income', generic: ['薪水', '月薪', '薪資', '發薪'] },
  { names: ['獎金'], kind: 'income', generic: ['獎金', '年終'] },
  { names: ['兼職外快', '兼職'], kind: 'income', generic: ['兼職', '外快', '接案'] },
  { names: ['禮金紅包'], kind: 'income', generic: ['紅包', '禮金', '收紅包'] },
  { names: ['退款'], kind: 'income', generic: ['退款', '退費'] },
  { names: ['利息'], kind: 'income', generic: ['利息'] },
  { names: ['股利'], kind: 'income', generic: ['股利', '配息', '股息'] },
  { names: ['中獎'], kind: 'income', generic: ['中獎', '彩券'] },
];

export interface CategoryMatch {
  category: NlpCategory;
  /** 文字裡認出分類的那個詞 */
  term: string;
  /** true：這個詞就是在說分類本身，備註不需要再寫一次 */
  generic: boolean;
}

/**
 * 找出文字提到的分類。
 * 1. 分類名稱本身（「早餐」「晚餐」「計程車」）；「其他」不算
 * 2. 常見說法（「手搖飲」→ 飲料、「小黃」→ 計程車）；只在使用者真的有這個名稱的分類時才採用
 * 取最長的詞；一樣長時優先子分類，再優先先出現的。
 */
export function matchCategory(text: string, cats: NlpCategory[], kind?: 'expense' | 'income'): CategoryMatch | undefined {
  const lower = text.toLowerCase();
  const cands: (CategoryMatch & { index: number })[] = [];
  const sub = (c: NlpCategory) => (c.parentId ? 1 : 0);
  const byName = (names: string[], k: 'expense' | 'income') => {
    for (const n of names) {
      const hits = cats.filter((c) => c.name === n && c.kind === k).sort((a, b) => sub(b) - sub(a));
      if (hits[0]) return hits[0];
    }
    return undefined;
  };
  for (const c of cats) {
    if (c.name === '其他' || c.name.length < 2 || (kind && c.kind !== kind)) continue;
    const i = lower.indexOf(c.name.toLowerCase());
    if (i >= 0) cands.push({ category: c, term: c.name, generic: true, index: i });
  }
  for (const syn of SYNONYMS) {
    if (kind && syn.kind !== kind) continue;
    const target = byName(syn.names, syn.kind);
    if (!target) continue;
    for (const [list, generic] of [[syn.generic, true], [syn.specific ?? [], false]] as const) {
      for (const w of list) {
        const i = lower.indexOf(w.toLowerCase());
        if (i >= 0) cands.push({ category: target, term: text.slice(i, i + w.length), generic, index: i });
      }
    }
  }
  cands.sort((a, b) => b.term.length - a.term.length || sub(b.category) - sub(a.category) || a.index - b.index);
  const best = cands[0];
  return best && { category: best.category, term: best.term, generic: best.generic };
}

/** 分類名稱出現在文字中：取最長的名稱（「其他」不算） */
export function findCategory(text: string, cats: NlpCategory[], kind?: 'expense' | 'income'): NlpCategory | undefined {
  return matchCategory(text, cats, kind)?.category;
}

