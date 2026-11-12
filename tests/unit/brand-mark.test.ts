// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as IconModule from '@/ui/Icon';

describe('品牌標記改用 Lucide asterisk 星芒', () => {
  it('asterisk 為三筆圓頭直線，與全 App 圖示同一套 24×24 currentColor 語言', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(IconModule.Icon, { name: 'asterisk', size: 26, stroke: 2.2, className: 'brand' }));
    });
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('stroke-linecap')).toBe('round');
    expect(svg?.querySelectorAll('path')).toHaveLength(3);
    expect(svg?.classList.contains('brand')).toBe(true);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('舊立體漸層 Logo 元件已完全移除', () => {
    expect('Logo' in IconModule).toBe(false);
  });
});