import { describe, expect, it } from 'vitest';
import { localView, looksLikeOperation } from '@/domain/agent/intent';

describe('操作意圖判斷（保守）', () => {
  it('整理帳本的說法會轉給操作助手', () => {
    for (const t of [
      '幫我把上個月所有 Uber 跟台灣大車隊都改歸類到通勤',
      '把全部 Uber 歸到交通分類',
      '幫我設通勤每月預算 3000，超過 80% 提醒我',
      '建立每月 12 號 Netflix 390 的訂閱',
      '如果我一次還房貸 20 萬可以省多少',
      '提前還款試算',
      '把飲食預算調成 8000',
      '飲食預算改成 8000',
      '以後只要出現 Uber 就自動歸到交通',
      '新增自動分類規則：星巴克算飲食',
      '幫我設一個年底前存 5 萬去日本玩的目標',
      '新增存錢目標 10 萬',
      '我今天領年終 20 萬進台新，拿 5 萬提前還信貸、買 1000 股 0050、把欠小明的 3500 結清，剩下撥進日本旅遊目標',
      '買 1000 股 0050',
      '把欠小明的 3,500 結清',
      '拿台新的 5 萬還信貸',
      '把剩下的撥進日本旅遊目標',
    ]) expect(looksLikeOperation(t), t).toBe(true);
  });
  it('一般記帳與問答不受影響', () => {
    for (const t of ['午餐 120', '昨天計程車兩百三', '上個月吃飯花多少', '這個月哪裡花太多？', '備註改成早餐', '預算還剩多少', '晚餐 350 刷玉山卡', '目標達成率多少', '買日本旅行機票 12000']) expect(looksLikeOperation(t), t).toBe(false);
  });
  it('一般記帳說法不會被新動作誤判', () => {
    for (const t of ['買咖啡 120', '買菜 350', '還朋友 500', '轉帳手續費 15', '股票手續費 20', '存錢筒 100']) expect(looksLikeOperation(t), t).toBe(false);
  });
});

describe('對話即介面：短句直接出檢視卡（不用 AI）', () => {
  it('認得財務自由、現金流、稅務、花費與「幾歲退休」', () => {
    expect(localView('財務自由')).toEqual({ kind: 'fire', params: {} });
    expect(localView('給我看退休試算')).toEqual({ kind: 'fire', params: {} });
    expect(localView('如果 55 歲退休會怎樣')).toEqual({ kind: 'fire', params: { retire_age: 55 } });
    expect(localView('五十歲退休')).toEqual({ kind: 'fire', params: { retire_age: 50 } });
    expect(localView('現金流')).toEqual({ kind: 'cashflow', params: {} });
    expect(localView('看稅務規劃')).toEqual({ kind: 'tax', params: {} });
    expect(localView('二代健保')).toEqual({ kind: 'tax', params: {} });
    expect(localView('上個月花費')).toEqual({ kind: 'spending', params: { range: 'last_month' } });
    expect(localView('這個月的支出分析')).toEqual({ kind: 'spending', params: { range: 'this_month' } });
  });
  it('一般句子不會被攔截', () => {
    for (const t of ['午餐 120', '我今年股利會被扣二代健保嗎？', '財務自由要多少錢才夠，幫我評估', '退休後每月花 5 萬夠嗎', '上個月吃飯花多少']) expect(localView(t), t).toBeNull();
  });
});
