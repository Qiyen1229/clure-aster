import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { parseCSV, toCSV, detectDelimiter } from '@/services/csv';
import { buildXlsx } from '@/services/xlsx';
import { autoMap, parseRows, planImport, runImport } from '@/services/importer';
import { derToRaw } from '@/services/lock';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';

describe('CSV', () => {
  it('引號、跳脫、換行、BOM', () => {
    const rows = parseCSV('﻿a,b,c\r\n1,"he said ""hi""","x\ny"\n\n2,,3');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', 'he said "hi"', 'x\ny'], ['2', '', '3']]);
  });
  it('分隔符號偵測與往返', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    const csv = toCSV([['名稱', '金額'], ['午餐, 便當', 120]]);
    expect(parseCSV(csv)).toEqual([['名稱', '金額'], ['午餐, 便當', '120']]);
  });
});

describe('XLSX', () => {
  it('產生合法的 zip 結構與內容', () => {
    const bin = buildXlsx([{ name: '帳目', rows: [['日期', '金額'], ['2026-10-10', 120], ['<&>', null]] }]);
    const files = unzipSync(bin);
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    const xml = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(xml).toContain('<v>120</v>');
    expect(xml).toContain('&lt;&amp;&gt;');
    expect(strFromU8(files['xl/workbook.xml'])).toContain('name="帳目"');
  });
});

describe('WebAuthn DER → raw', () => {
  it('去除前導 0 並補足 32 bytes', () => {
    const r = new Uint8Array(33); r[0] = 0; r.fill(1, 1);
    const s = new Uint8Array(31).fill(2);
    const der = new Uint8Array([0x30, 2 + 33 + 2 + 31, 0x02, 33, ...r, 0x02, 31, ...s]);
    const raw = derToRaw(der);
    expect(raw.length).toBe(64);
    expect(raw[0]).toBe(1);
    expect(raw[32]).toBe(0);
    expect(raw[33]).toBe(2);
  });
});

const MOZE = `帳戶,幣種,記錄類型,主類別,子類別,金額,手續費,折扣,名稱,商家,日期,時間,專案,描述,標籤,對象
現金,TWD,支出,飲食,午餐,-120,0,0,便當,池上,2026/10/01,12:10,,,#公司,
玉山卡,TWD,支出,購物,網購,-1590,0,0,耳機,momo,2026/10/02,21:00,,,,
薪轉,TWD,收入,薪資,本薪,62000,0,0,十月薪資,,2026/10/05,09:00,,,,
薪轉,TWD,轉出,,,-5000,15,0,提款,,2026/10/05,12:00,,,,
現金,TWD,轉入,,,5000,0,0,提款,,2026/10/05,12:00,,,,
現金,TWD,餘額調整,,,-30,0,0,,,2026/10/06,08:00,,,,
小明,TWD,應收款項,,,300,0,0,,,2026/10/06,08:00,,,,
壞資料,TWD,支出,,,abc,0,0,,,2026/13/45x,08:00,,,,`;

describe('Moze 匯入', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
  });
  it('自動辨識 Moze 欄位、配對轉帳、建立帳戶並正確計算餘額', async () => {
    const [header, ...body] = parseCSV(MOZE);
    const { mapping, isMoze } = autoMap(header);
    expect(isMoze).toBe(true);
    expect(mapping.amount).toBe(5);
    const rows = parseRows(body, mapping, { currency: 'TWD', account: '' });
    expect(rows[0]).toMatchObject({ kind: 'expense', date: '2026-10-01', time: '12:10', note: '便當 @池上', tags: ['公司'] });
    expect(rows[7].error).toBeTruthy();
    const plan = await planImport(rows);
    expect(plan).toMatchObject({ transfers: 1, skipped: 1 });
    expect(plan.errors).toHaveLength(1);
    expect(plan.newAccounts.sort()).toEqual(['玉山卡', '現金', '薪轉'].sort());
    const r = await runImport(rows, 'TWD');
    expect(r).toEqual({ txs: 4, transfers: 1 });
    const acc = new Map((await db.accounts.toArray()).map((a) => [a.name, a]));
    expect(acc.get('現金')!.balanceMinor).toBe(-12000 + 500000 - 3000);
    expect(acc.get('薪轉')!.balanceMinor).toBe(6200000 - 500000 - 1500);
    expect(acc.get('玉山卡')!.type).toBe('credit');
    expect(acc.get('玉山卡')!.balanceMinor).toBe(-159000);
    // 午餐分類對應到既有的「飲食 › 午餐」
    const lunch = (await db.transactions.toArray()).find((t) => t.note.startsWith('便當'))!;
    expect(lunch.categoryId).toBe('exp-food-lunch');
  });
});
