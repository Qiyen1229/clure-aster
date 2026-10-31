import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExplainButton } from '@/ui/Explain';

describe('ⓘ 為什麼這樣算', () => {
  it('渲染成帶有無障礙名稱的按鈕（說明面板點開才出現）', () => {
    const html = renderToStaticMarkup(createElement(ExplainButton, { title: '剩餘可用額度', formula: 'a = b − c' }));
    expect(html).toContain('為什麼這樣算：剩餘可用額度');
    expect(html).toContain('explain-btn');
  });
});
