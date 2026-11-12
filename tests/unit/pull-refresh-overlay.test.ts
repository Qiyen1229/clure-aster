// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { isOverlayTouch, PullToRefresh } from '@/ui/PullToRefresh';

function touch(el: Element, type: string, y: number) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: [{ clientX: 20, clientY: y }] });
  el.dispatchEvent(e);
}

describe('isOverlayTouch：彈窗來源的 touch 不啟動下拉更新', () => {
  it('抽屜、抽屜背景、對話視窗（含背景）、WhatsNew／鎖定畫面都算彈窗', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="sheet"><div class="sheet-body"><button id="in-sheet">x</button></div></div>
      <div class="sheet-backdrop" id="bd"></div>
      <div class="dlg-wrap"><div class="dlg-backdrop" id="dlg-bd"></div><div class="dlg" role="alertdialog"><button id="in-dlg">x</button></div></div>
      <div class="whatsnew-wrap" role="dialog"><div class="whatsnew-backdrop" id="wn-bd"></div></div>
      <main class="page"><button id="in-page">x</button></main>`;
    document.body.appendChild(host);
    for (const id of ['in-sheet', 'bd', 'dlg-bd', 'in-dlg', 'wn-bd']) {
      expect(isOverlayTouch(host.querySelector('#' + id)), id).toBe(true);
    }
    expect(isOverlayTouch(host.querySelector('#in-page'))).toBe(false);
    expect(isOverlayTouch(null)).toBe(false);
    host.remove();
  });
});

describe('PullToRefresh：彈窗內下滑關閉不會同時觸發更新', () => {
  it('touch 從彈窗冒泡上來不觸發 onRefresh；從頁面內容下拉仍正常觸發', async () => {
    const onRefresh = vi.fn(async () => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(PullToRefresh, {
          onRefresh,
          children: [
            React.createElement('div', { id: 'page-top', key: 'p' }, 'content'),
            // 模擬 portal 彈窗：DOM 在別處、React 樹仍是子節點，touch 會冒泡到 PullToRefresh
            React.createElement('div', { role: 'dialog', key: 'd' }, React.createElement('button', { id: 'sheet-btn' }, 'sheet')),
          ],
        }),
      );
    });

    const sheetBtn = container.querySelector('#sheet-btn')!;
    await act(async () => { touch(sheetBtn, 'touchstart', 100); });
    await act(async () => { touch(sheetBtn, 'touchmove', 180); touch(sheetBtn, 'touchmove', 260); });
    await act(async () => { touch(sheetBtn, 'touchend', 260); });
    expect(onRefresh).not.toHaveBeenCalled();

    const pageTop = container.querySelector('#page-top')!;
    await act(async () => { touch(pageTop, 'touchstart', 100); });
    await act(async () => { touch(pageTop, 'touchmove', 180); touch(pageTop, 'touchmove', 260); });
    await act(async () => { touch(pageTop, 'touchend', 260); });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => { root.unmount(); });
    container.remove();
  });
});