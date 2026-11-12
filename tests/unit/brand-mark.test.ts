// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as IconModule from '@/ui/Icon';

describe('品牌標記改用極簡花體 A', () => {
  it('brand 為三筆圓頭筆鋒＋頂峰星點，與全 App 圖示同一套 24×24 currentColor 語言', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(IconModule.Icon, { name: 'brand', size: 26, stroke: 2, className: 'brand' }));
    });
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('stroke-linecap')).toBe('round');
    const paths = svg?.querySelectorAll('path');
    expect(paths).toHaveLength(3);
    expect(paths?.[2].getAttribute('stroke-width')).toBe('1.8');
    const dot = svg?.querySelector('circle');
    expect(dot?.getAttribute('fill')).toBe('currentColor');
    expect(dot?.getAttribute('stroke')).toBe('none');
    expect(svg?.classList.contains('brand')).toBe(true);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('舊立體漸層 Logo 元件與星芒標記已完全移除', async () => {
    expect('Logo' in IconModule).toBe(false);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(IconModule.Icon, { name: 'asterisk' as IconModule.IconName, size: 26 }));
    });
    expect(container.querySelectorAll('path')).toHaveLength(0);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});