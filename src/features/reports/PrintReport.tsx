/**
 * 可列印的月報表：瀏覽器「列印 → 儲存為 PDF」（iPhone：分享 → 列印 → 兩指放大預覽 → 分享 PDF）。
 * 用 HTML + CSS 排版而非 PDF 函式庫，中文字型完美、檔案小、離線可用。
 */
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { analyze } from '@/domain/reports';
import { accountingMonth, todayKey } from '@/domain/period';
import { formatMoney } from '@/domain/money';
import { statAmount } from '@/domain/ledger';
import { useAccounts, useCategories } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';

export default function PrintReport() {
  const [p] = useSearchParams();
  const navigate = useNavigate();
  const { baseCurrency: base, monthStartDay } = useSettings();
  const def = accountingMonth(todayKey(), monthStartDay);
  const range = { start: p.get('start') ?? def.start, end: p.get('end') ?? def.end };
  const cats = useCategories();
  const accounts = useAccounts(true);
  const txs = useLiveQuery(() => db.transactions.where('date').between(range.start, range.end, true, true).filter((t) => !t.deletedAt).toArray(), [range.start, range.end]);
  const a = useMemo(() => (txs ? analyze(txs, cats.map, range) : null), [txs, cats.map]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = (v: number) => formatMoney(v, base);
  if (!a || !txs) return null;
  const top = [...a.byMain].sort((x, y) => y[1] - x[1]);
  const list = txs.filter((t) => t.type !== 'adjust' && !t.excludeFromStats).sort((x, y) => (x.date === y.date ? x.ts - y.ts : x.date < y.date ? -1 : 1));

  return (
    <div className="print-page">
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="btn secondary small" onClick={() => navigate(-1)}><Icon name="chevronL" size={16} />返回</button>
        <button className="btn small" onClick={() => window.print()}><Icon name="download" size={16} />列印／儲存 PDF</button>
      </div>
      <h1>Clure 記帳報表</h1>
      <p className="muted">{range.start} ～ {range.end}・主幣別 {base}・產生於 {new Date().toLocaleString('zh-TW')}</p>
      <table className="print-table">
        <tbody>
          <tr><th>總收入</th><td>{f(a.income)}</td><th>總支出</th><td>{f(a.expense)}</td></tr>
          <tr><th>結餘</th><td>{f(a.net)}</td><th>儲蓄率</th><td>{a.savingRate === null ? '—' : `${a.savingRate.toFixed(1)}%`}</td></tr>
          <tr><th>日均花費</th><td>{f(a.dailyAvg)}</td><th>筆數</th><td>{a.count}</td></tr>
        </tbody>
      </table>
      <h2>支出分類</h2>
      <table className="print-table">
        <thead><tr><th>分類</th><th style={{ width: '45%' }}>佔比</th><th>金額</th></tr></thead>
        <tbody>
          {top.map(([id, v]) => (
            <tr key={id}>
              <td>{cats.map.get(id)?.icon} {cats.map.get(id)?.name}</td>
              <td><div className="print-bar"><i style={{ width: `${(v / a.expense) * 100}%`, background: cats.map.get(id)?.color }} /></div>{((v / a.expense) * 100).toFixed(1)}%</td>
              <td className="num">{f(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>明細（{list.length} 筆）</h2>
      <table className="print-table small">
        <thead><tr><th>日期</th><th>分類</th><th>帳戶</th><th>備註</th><th>金額</th></tr></thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id}>
              <td>{t.date.slice(5)}</td><td>{cats.map.get(t.categoryId)?.name}</td><td>{accounts.map.get(t.accountId)?.name}</td>
              <td>{t.note}</td><td className="num">{t.type === 'income' ? '+' : '-'}{f(statAmount(t))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
