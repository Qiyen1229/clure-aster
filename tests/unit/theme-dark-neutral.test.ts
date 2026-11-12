import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Vitest 預設把 CSS import 換成空字串，改讀原始檔檢查 token 架構。
const css = readFileSync(new URL('../../src/theme/app.css', import.meta.url), 'utf8');

const PALETTES = ['graphite', 'jade', 'amber'] as const;
const SURFACE_TOKENS = ['--bg', '--surface', '--surface-2', '--text', '--text-2', '--sep'] as const;

function ruleBody(selector: RegExp): string {
  const m = css.match(selector);
  expect(m, `找不到規則：${selector}`).not.toBeNull();
  return m![1];
}

const sharedDarkSelector = /:root:is\(\[data-palette='graphite'\][^)]*\)\[data-theme='dark'\]\s*\{([^}]*)\}/;
const paletteDark = (p: string) => new RegExp(`:root\\[data-palette='${p}'\\]\\[data-theme='dark'\\]\\s*\\{([^}]*)\\}`);
const paletteLight = (p: string) => new RegExp(`:root\\[data-palette='${p}'\\]\\s*\\{([^}]*)\\}`);

describe('深色模式中性灰底：三套主題共用表面色，色相只留在 accent', () => {
  it.each(SURFACE_TOKENS)('共用深色規則以實體色票定義 %s（非 var 推導）', (token) => {
    expect(ruleBody(sharedDarkSelector)).toMatch(new RegExp(`${token}:\\s*#[0-9a-f]{6}`));
  });

  it.each(PALETTES)('%s 深色規則只帶 --accent 與 --on-accent，不覆寫中性表面', (palette) => {
    const body = ruleBody(paletteDark(palette));
    expect(body).toMatch(/--accent:\s*#[0-9a-f]{6}/);
    expect(body).toMatch(/--on-accent:\s*#[0-9a-f]{6}/);
    for (const token of [...SURFACE_TOKENS, '--accent-soft']) {
      expect(body, `${palette} 深色不應覆寫 ${token}`).not.toContain(`${token}:`);
    }
  });

  it('三套主題的深色 accent 各自不同', () => {
    const accents = PALETTES.map((p) => ruleBody(paletteDark(p)).match(/--accent:\s*(#[0-9a-f]{6})/)![1]);
    expect(new Set(accents).size).toBe(PALETTES.length);
  });

  it('深色 accent-soft 由 accent 混入中性表面推導，新主題不必另寫', () => {
    expect(ruleBody(sharedDarkSelector)).toContain('--accent-soft: color-mix(in srgb, var(--accent) 18%, var(--surface))');
  });

  it.each(PALETTES)('%s 淺色規則保留自己的色相背景', (palette) => {
    const body = ruleBody(paletteLight(palette));
    expect(body).toMatch(/--bg:\s*#[0-9a-f]{6}/);
    expect(body).toMatch(/--surface:\s*#[0-9a-f]{6}/);
    expect(body).toMatch(/--accent-soft:\s*#[0-9a-f]{6}/);
  });
});

describe('中央品牌按鈕平面化（與首頁＋同一套霧面語言）', () => {
  it('mode-logo 是 48px 霧面實色圓盤，沒有漸層與立體變體', () => {
    const body = ruleBody(/\.dynamic-fab\.mode-logo\s*\{([^}]*)\}/);
    expect(body).toContain('width: 48px');
    expect(body).toContain('background: var(--surface)');
    expect(body).not.toMatch(/gradient/);
    expect(css).not.toContain('.dynamic-fab.mode-logo::before');
    expect(css).not.toContain(":root:not([data-theme='dark']) .dynamic-fab.mode-logo");
  });

  it('品牌星芒圖層 26px、無立體陰影；圓盤顏色跟隨主題 accent', () => {
    const body = ruleBody(/\.fab-layer \.brand\s*\{([^}]*)\}/);
    expect(body).toContain('width: 26px');
    expect(body).not.toContain('drop-shadow');
    expect(css).not.toContain('.fab-layer .logo');
    expect(ruleBody(/\.dynamic-fab\.mode-logo\s*\{([^}]*)\}/)).toContain('color: var(--accent)');
  });

  it('按壓、滑動與長按手勢的回饋類別仍保留', () => {
    expect(css).toContain('.dynamic-fab:active, .dynamic-fab.pressing');
    expect(css).toContain('.dynamic-fab.scrub-target');
    expect(css).toContain('.dynamic-fab.ai-hold');
  });
});