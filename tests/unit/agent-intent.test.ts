import { describe, expect, it } from 'vitest';
import { looksLikeOperation } from '@/domain/agent/intent';

describe('操作意圖判斷（保守）', () => {
  it('整理帳本的說法會轉給操作助手', () => {
    for (const t of [
      '幫我把上個月所有 Uber 跟台灣大車隊都改歸類到通勤',
      '把全部 Uber 歸到交通分類',
      '幫我設通勤每月預算 3000，超過 80% 提醒我',
      '建立每月 12 號 Netflix 390 的訂閱',
      '如果我一次還房貸 20 萬可以省多少',
      '提前還款試算',
    ]) expect(looksLikeOperation(t), t).toBe(true);
  });
  it('一般記帳與問答不受影響', () => {
    for (const t of ['午餐 120', '昨天計程車兩百三', '上個月吃飯花多少', '這個月哪裡花太多？', '備註改成早餐', '預算還剩多少', '晚餐 350 刷玉山卡']) expect(looksLikeOperation(t), t).toBe(false);
  });
});
