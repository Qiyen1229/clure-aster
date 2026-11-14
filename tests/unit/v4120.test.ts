import { describe, expect, it } from 'vitest';
import { RELEASE_NOTES } from '@/features/whatsnew/releaseNotes';
import { getRecentFeatures, openWhatsNew, useWhatsNewStore } from '@/features/whatsnew/WhatsNew';
import { CatIcon, EMOJI_TO_LUCIDE } from '@/ui/CatIcon';
import React from 'react';
import { renderToString } from 'react-dom/server';

describe('v4.1.20 新功能彈窗與標題精簡', () => {
  it('近期版本的新功能標題皆維持在 10 字以內，簡潔俐落', () => {
    const recent = RELEASE_NOTES.filter((n) => ['4.1.20', '4.1.19', '4.1.18', '4.1.17', '4.1.16'].includes(n.version));
    for (const note of recent) {
      for (const feature of note.features) {
        expect(feature.title.length, `版本 ${note.version} 的標題「${feature.title}」超過 10 字`).toBeLessThanOrEqual(10);
      }
    }
  });

  it('4.1.19 動效標題已精煉為「優化動態效果」', () => {
    const n19 = RELEASE_NOTES.find((n) => n.version === '4.1.19');
    expect(n19).toBeDefined();
    expect(n19?.features.some((f) => f.title === '優化動態效果')).toBe(true);
  });

  it('getRecentFeatures 能夠取得最新版本的重點功能清單', () => {
    const items = getRecentFeatures();
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0].version).toBe(RELEASE_NOTES[0].version);
  });

  it('openWhatsNew 能夠主動觸發新功能彈窗狀態', () => {
    useWhatsNewStore.setState({ manualSeq: 0, manualItems: null });
    openWhatsNew();
    expect(useWhatsNewStore.getState().manualSeq).toBe(1);
    expect(useWhatsNewStore.getState().manualItems).toBeNull();

    useWhatsNewStore.getState().close();
    expect(useWhatsNewStore.getState().manualItems).toBeNull();
  });
});

describe('v4.1.20 分類與帳戶 Lucide 向量圖標升級（CatIcon）', () => {
  it('分類常用 emoji 皆完整映射至 Lucide 圖標', () => {
    expect(EMOJI_TO_LUCIDE['🍱']).toBe('utensils');
    expect(EMOJI_TO_LUCIDE['👕']).toBe('shirt');
    expect(EMOJI_TO_LUCIDE['🏠']).toBe('home');
    expect(EMOJI_TO_LUCIDE['🚇']).toBe('train');
    expect(EMOJI_TO_LUCIDE['📚']).toBe('book-open');
    expect(EMOJI_TO_LUCIDE['🎮']).toBe('gamepad-2');
    expect(EMOJI_TO_LUCIDE['🩺']).toBe('stethoscope');
  });

  it('帳戶常用 emoji 皆完整映射至 Lucide 圖標', () => {
    expect(EMOJI_TO_LUCIDE['💵']).toBe('banknote');
    expect(EMOJI_TO_LUCIDE['🏦']).toBe('landmark');
    expect(EMOJI_TO_LUCIDE['💳']).toBe('credit-card');
    expect(EMOJI_TO_LUCIDE['📲']).toBe('smartphone');
    expect(EMOJI_TO_LUCIDE['📈']).toBe('trending-up');
  });

  it('CatIcon 渲染 mapped emoji 時輸出 Lucide SVG，而非純文字', () => {
    const htmlFood = renderToString(React.createElement(CatIcon, { icon: '🍱' }));
    expect(htmlFood).toContain('<svg');
    expect(htmlFood).toContain('cat-vector-icon');
    expect(htmlFood).not.toContain('🍱');

    const htmlCard = renderToString(React.createElement(CatIcon, { icon: '💳' }));
    expect(htmlCard).toContain('<svg');
    expect(htmlCard).not.toContain('💳');
  });

  it('CatIcon 支援直接傳入 Lucide 圖標名稱', () => {
    const html = renderToString(React.createElement(CatIcon, { icon: 'utensils' }));
    expect(html).toContain('<svg');
  });

  it('CatIcon 遇到未知自訂文字時優雅降級為文字輸出', () => {
    const html = renderToString(React.createElement(CatIcon, { icon: '👽' }));
    expect(html).toContain('👽');
  });
});

describe('v4.1.20 設定頁面全面採用 Lucide 圖標', () => {
  it('Icon 元件支援設定頁專用 Lucide 向量圖標', async () => {
    const { Icon } = await import('@/ui/Icon');
    const icons = ['tags', 'slidersHorizontal', 'receipt', 'palette', 'shieldCheck', 'database', 'inbox', 'compass', 'bell', 'info'] as const;
    for (const name of icons) {
      const html = renderToString(React.createElement(Icon, { name }));
      expect(html).toContain('<svg');
      expect(html).toContain('viewBox="0 0 24 24"');
    }
  });

  it('Cilo 圖標保留原創多面彩虹寶石（AiGem）', async () => {
    const { Icon } = await import('@/ui/Icon');
    const html = renderToString(React.createElement(Icon, { name: 'ai' }));
    expect(html).toContain('<svg');
    expect(html).toContain('polygon');
    expect(html).toContain('linearGradient');
  });
});
