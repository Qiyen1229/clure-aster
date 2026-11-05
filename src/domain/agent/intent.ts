/**
 * 判斷一句話是不是在「要求整理帳本」（批次改分類、設預算、建週期帳目、提前還款試算），
 * 是的話首頁對話框會轉交給操作助手（先預覽、你確認才執行），而不是當成記一筆或問答。
 * 刻意保守：寧可漏掉也不要把一般記帳（「午餐 120」）誤判成操作。
 */
const PATTERNS: RegExp[] = [
  /(改(成|為|歸|到)|歸(類)?到|重新分類|統一(分類|歸)|批次)/,
  /(設(定)?|建立|新增|幫我(設|建)).{0,12}預算/,
  /(建立|新增|幫我(建|設)).{0,24}(訂閱|週期|定期|固定)/,
  /(提前還款|提早還款|一次還.{0,8}(房貸|車貸|信貸|學貸|貸款)|多還)/,
];
// 「改」需要搭配分類或歸類的語意，單純的「改成」（例如備註）不算
const NEEDS_CATEGORY_WORD = /分類|歸類|歸到|歸入|改歸|類別|都改/;

export function looksLikeOperation(text: string): boolean {
  const s = text.trim();
  if (s.length < 6) return false;
  if (PATTERNS[0].test(s)) return NEEDS_CATEGORY_WORD.test(s);
  return PATTERNS.slice(1).some((p) => p.test(s));
}
