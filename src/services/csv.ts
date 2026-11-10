/**
 * CSV 解析／產生（RFC 4180：引號、跳脫、換行）。自動去除 BOM、偵測分隔符號（, ; Tab）。
 */
export function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCSV(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

export function toCSV(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    // CSV 公式注入防護（Formula / DDE Injection）：
    // 若儲存格開頭為 =、+、-、@、\t、\r，Excel 等試算表軟體會將其當作公式或指令執行。
    // 純數字（如 -120 或 +50）保持原樣，其餘前綴單引號 ' 進行轉義。
    if (typeof v !== 'number' && /^[+=@\t\r-]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s.trim())) {
      s = `'${s}`;
    }
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // 加 BOM，Excel 開啟中文才不會亂碼
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
