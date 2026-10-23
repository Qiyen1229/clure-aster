/** 由目前 CSS token 取得圖表配色（不依賴 ECharts，可在任何地方引用） */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 由目前 CSS token 組出圖表共用樣式 */
export function chartTheme() {
  return {
    text: cssVar('--text'),
    text2: cssVar('--text-2'),
    text3: cssVar('--text-3'),
    sep: cssVar('--sep'),
    accent: cssVar('--accent'),
    pos: cssVar('--c-pos'),
    neg: cssVar('--c-neg'),
    surface: cssVar('--surface'),
    font: getComputedStyle(document.body).fontFamily,
  };
}

