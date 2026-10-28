/**
 * v2.0：搜尋頁判斷要不要提供「問 AI」
 */
import { describe, expect, it } from 'vitest';
import { looksLikeAiQuestion } from '@/domain/nlquery';

describe('looksLikeAiQuestion', () => {
  it.each(['怎麼存錢比較快？', '我下個月要怎麼分配預算', '要不要提早還房貸', '這樣的支出正常嗎?', '請問信用卡要怎麼省', '幫我分析這個月的花費'])('是請教的問題：%s', (t) => {
    expect(looksLikeAiQuestion(t)).toBe(true);
  });
  it.each(['午餐', 'Netflix', '120', '麥當勞 150', '上個月吃飯花多少', '咖啡'])('是一般搜尋：%s', (t) => {
    expect(looksLikeAiQuestion(t)).toBe(false);
  });
  it('太短不算（避免一般關鍵字誤判）', () => {
    expect(looksLikeAiQuestion('好嗎？')).toBe(false);
  });
});
