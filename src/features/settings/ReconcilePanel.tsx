/**
 * 對帳面板：帳單明細（CSV 或 AI 讀截圖）vs 帳本 → 吻合／漏記／金額有差／帳本多的，
 * 勾選後「一鍵補齊並平帳」（可復原）。比對全部在本機，不呼叫 AI。
 */
import { useEffect, useMemo, useState } from 'react';
import { categoryLabel, useAccounts, useCategories } from '@/app/hooks';
import { deleteTransactions } from '@/db/repo/ledger';
import { fromMinor, formatMoney, toMinor } from '@/domain/money';
import { reconcile, REASON_LABEL, summarizeReport, type LedgerRow, type StmtRow } from '@/domain/reconcile';
import { applyFixes, loadLedgerRows, stmtFromAi, stmtFromCsv, suggestForMissing } from '@/services/reconcile';
import type { StatementEntry } from '@/services/ai';
import type { ParsedRow } from '@/services/importer';
import { snackUndo, useUI } from '@/stores/ui';
import { Switch } from '@/ui/controls';

interface Props {
  /** 二選一：CSV 解析後的列，或 AI 讀截圖得到的明細（金額依選定帳戶的幣別換算） */
  csvRows?: ParsedRow[];
  aiEntries?: StatementEntry[];
  /** AI 讀到的帳單合計（元）；帳單沒印就是 null */
  printedTotal?: number | null;
  /** 預設選哪個帳戶（依名稱比對） */
  defaultAccountName?: string;
  onDone: () => void;
}

export function ReconcilePanel({ csvRows, aiEntries, printedTotal, defaultAccountName, onDone }: Props) {
  const source = aiEntries ? 'ai' : 'csv';
  const accounts = useAccounts();
  const cats = useCategories();
  const [rows, setRows] = useState<StmtRow[]>([]);
  const [accountId, setAccountId] = useState('');
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [sug, setSug] = useState<Map<string, string>>(new Map());
  const [catPick, setCatPick] = useState<Record<string, string>>({});
  const [offMissing, setOffMissing] = useState<Set<string>>(new Set());
  const [offVar, setOffVar] = useState<Set<string>>(new Set());
  const [actual, setActual] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);

  const acc = accounts.list.find((a) => a.id === accountId);
  const accCur = acc?.currency;
  // 帳單金額依選定帳戶的幣別換算；換帳戶就重新換算（AI 明細的手動修改會重來）
  useEffect(() => {
    if (!accCur) return;
    setRows(aiEntries ? stmtFromAi(aiEntries, accCur) : stmtFromCsv(csvRows ?? [], accCur));
  }, [accCur]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (accountId || !accounts.list.length) return;
    const pick = accounts.list.find((a) => a.name === defaultAccountName) ?? accounts.list.find((a) => a.type === 'credit') ?? accounts.list.find((a) => a.type === 'bank') ?? accounts.list[0];
    setAccountId(pick.id);
  }, [accounts.list, accountId, defaultAccountName]);

  const reload = () => { if (accountId) void loadLedgerRows(accountId, rows).then(setLedger); };
  useEffect(reload, [accountId, rows]);  

  const report = useMemo(() => (ledger && acc ? reconcile(rows, ledger, acc.currency) : null), [rows, ledger, acc]);
  useEffect(() => { if (report?.missing.length) void suggestForMissing(report.missing).then(setSug); }, [report?.missing.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!acc || !report) return <p className="muted" style={{ margin: 16 }}>比對中…</p>;
  const cur = acc.currency;
  const money = (m: number) => formatMoney(m, cur, { decimals: 0 });
  const kindCats = (k: 'expense' | 'income') => cats.all.filter((c) => c.kind === k && !c.archived && !c.system);
  const missingSel = report.missing.filter((m) => !offMissing.has(m.id));
  const varSel = report.variances.filter((v) => !offVar.has(v.stmt.id) && v.diffMinor !== 0);
  const printedMinor = printedTotal ? toMinor(printedTotal, cur) : null;
  const totalGap = printedMinor !== null ? report.stmtTotalMinor - printedMinor : null;
  const needVerify = source === 'ai' && (totalGap === null || totalGap !== 0);
  const adjustTarget = actual.trim() ? (acc.isLiability ? -1 : 1) * toMinor(Math.abs(Number(actual.replace(/,/g, '')) || 0), cur) : null;
  const expectedBalance = acc.balanceMinor
    - missingSel.reduce((a, m) => a + (m.kind === 'expense' ? m.amountMinor : -m.amountMinor), 0)
    - varSel.reduce((a, v) => a + v.diffMinor, 0);
  const remaining = adjustTarget !== null ? adjustTarget - expectedBalance : 0;
  const nothingToDo = !missingSel.length && !varSel.length && !(adjustTarget !== null && remaining !== 0);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); setter(n); };

  const apply = async () => {
    if (busy || nothingToDo) return;
    setBusy(true);
    try {
      const ids = await applyFixes(acc, {
        missing: missingSel.map((row) => ({ row, categoryId: catPick[row.id] ?? sug.get(row.id) ?? '' })).filter((m) => m.categoryId),
        variances: varSel, adjustTo: adjustTarget,
      });
      setApplied(ids.length); setActual('');
      snackUndo(`已補齊 ${ids.length} 筆`, async () => { await deleteTransactions(ids); setApplied(null); reload(); });
      reload();
    } catch (e) { useUI.getState().showSnack({ text: `補齊失敗：${(e as Error).message}` }); } finally { setBusy(false); }
  };

  const allGood = !report.missing.length && !report.variances.length;
  return (
    <>
      <div className="card glass">
        <div className="field" style={{ padding: 0 }}>
          <span className="label">對帳的帳戶</span>
          <select value={accountId} onChange={(e) => { setAccountId(e.target.value); setApplied(null); }} aria-label="對帳的帳戶">
            {accounts.list.map((a) => <option key={a.id} value={a.id}>{a.name}（{a.currency}）</option>)}
          </select>
        </div>
        <p style={{ margin: '10px 0 4px', fontWeight: 600 }}>{allGood ? '✅ 全部吻合，沒有要補的' : summarizeReport(report, money)}</p>
        <p className="row-sub" style={{ whiteSpace: 'normal' }}>帳單 {rows.length} 筆，日期容差 ±3 天，金額與商家名稱一起比對。{applied ? `　已補齊 ${applied} 筆。` : ''}</p>
        {source === 'ai' && (
          <p className="row-sub" style={{ whiteSpace: 'normal', color: totalGap === 0 ? 'var(--success)' : 'var(--warning)' }}>
            {totalGap === 0 ? `✅ 讀到的明細加總 ${money(report.stmtTotalMinor)}，與帳單合計相符`
              : printedMinor !== null ? `⚠️ 讀到的明細加總 ${money(report.stmtTotalMinor)}，帳單合計 ${money(printedMinor)}，差 ${money(Math.abs(totalGap!))}：可能漏看或看錯，請對照截圖修正下方明細`
                : '帳單上沒有印合計，無法自動驗證，請對照截圖確認每一筆'}
          </p>
        )}
      </div>

      {source === 'ai' && (
        <details className="card" style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer' }}>AI 讀到的 {rows.length} 筆明細（可修改金額、刪除讀錯的）</summary>
          <div className="list" style={{ marginTop: 8 }}>
            {rows.map((r) => (
              <div key={r.id} className="row" style={{ gap: 8 }}>
                <span className="row-main"><span className="row-title">{r.text || '（無說明）'}</span><span className="row-sub" style={{ display: 'block' }}>{r.date}{r.kind === 'income' ? ' · 收入／退款' : ''}{r.foreignCurrency ? ` · 原幣 ${fromMinor(r.foreignMinor ?? 0, r.foreignCurrency).toString()} ${r.foreignCurrency}` : ''}</span></span>
                <input className="input num" inputMode="decimal" style={{ width: 92, textAlign: 'right' }} aria-label={`${r.text} 金額`} defaultValue={fromMinor(r.amountMinor, cur).toString()}
                  onBlur={(e) => { const v = Number(e.target.value.replace(/,/g, '')); if (v > 0) setRows((x) => x.map((y) => (y.id === r.id ? { ...y, amountMinor: toMinor(v, cur) } : y))); }} />
                <button className="icon-btn plain" aria-label={`刪除 ${r.text}`} onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}>✕</button>
              </div>
            ))}
          </div>
        </details>
      )}

      {report.missing.length > 0 && (
        <>
          <div className="section-title">漏記（帳單有、帳本沒有）{report.missing.length}</div>
          <div className="list">
            {report.missing.map((m) => {
              const k = m.kind;
              const val = catPick[m.id] ?? sug.get(m.id) ?? '';
              return (
                <div key={m.id} className="row" style={{ gap: 8 }}>
                  <Switch label={`補記 ${m.text}`} checked={!offMissing.has(m.id)} onChange={() => toggle(offMissing, setOffMissing, m.id)} />
                  <span className="row-main"><span className="row-title">{m.text || '（無說明）'}</span><span className="row-sub" style={{ display: 'block' }}>{m.date}</span></span>
                  <select className="mini-select" aria-label={`${m.text} 的分類`} value={val} onChange={(e) => setCatPick((p) => ({ ...p, [m.id]: e.target.value }))}>
                    {!val && <option value="">選分類</option>}
                    {kindCats(k).map((c) => <option key={c.id} value={c.id}>{categoryLabel(cats.map, c.id)}</option>)}
                  </select>
                  <span className="num">{k === 'income' ? '+' : '-'}{money(m.amountMinor)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {report.variances.length > 0 && (
        <>
          <div className="section-title">金額有差 {report.variances.length}</div>
          <div className="list">
            {report.variances.map((v) => (
              <div key={v.stmt.id} className="row" style={{ gap: 8 }}>
                <Switch label={`補差額 ${v.stmt.text}`} checked={!offVar.has(v.stmt.id)} onChange={() => toggle(offVar, setOffVar, v.stmt.id)} />
                <span className="row-main">
                  <span className="row-title">{v.stmt.text || v.ledger.text}</span>
                  <span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>帳單 {money(v.stmt.amountMinor)}、你記的 {money(v.ledger.accountMinor)}　{REASON_LABEL[v.reason ?? 'other']}</span>
                </span>
                <span className="num" style={{ color: v.diffMinor > 0 ? 'var(--danger)' : 'var(--success)' }}>{v.diffMinor > 0 ? '+' : '-'}{money(Math.abs(v.diffMinor))}</span>
              </div>
            ))}
          </div>
          <p className="row-sub" style={{ margin: '4px 8px 0', whiteSpace: 'normal' }}>勾選後會「另外記一筆差額」（匯差／手續費支出，或退回的收入），原本那筆不動，帳本看得出來。</p>
        </>
      )}

      {report.extra.length > 0 && (
        <>
          <div className="section-title">帳本有、帳單沒有 {report.extra.length}</div>
          <div className="list">
            {report.extra.map((e) => (
              <div key={e.id} className="row"><span className="row-main"><span className="row-title">{e.text || '（無備註）'}</span><span className="row-sub" style={{ display: 'block' }}>{e.date}</span></span><span className="num">{e.kind === 'income' ? '+' : '-'}{money(e.accountMinor)}</span></div>
            ))}
          </div>
          <p className="row-sub" style={{ margin: '4px 8px 0', whiteSpace: 'normal' }}>可能是還沒入帳（下期帳單才會出現），或不小心記重了；這裡不會自動刪除，請自己確認。</p>
        </>
      )}

      {report.matched.length > 0 && (
        <details style={{ margin: '12px 8px' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-2)' }}>✅ 已吻合 {report.matched.length} 筆</summary>
          <div className="list" style={{ marginTop: 8 }}>
            {report.matched.map((m) => <div key={m.stmt.id} className="row"><span className="row-main"><span className="row-title">{m.stmt.text || m.ledger.text}</span><span className="row-sub" style={{ display: 'block' }}>{m.stmt.date}{m.dayGap ? `（帳本記在 ${m.ledger.date}）` : ''}</span></span><span className="num">{money(m.stmt.amountMinor)}</span></div>)}
          </div>
        </details>
      )}

      <details className="card" style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer' }}>還是對不上？校正帳戶餘額（選填）</summary>
        <p className="row-sub" style={{ whiteSpace: 'normal' }}>輸入{acc.isLiability ? '帳單上的「目前欠款」' : '銀行 App 上看到的實際餘額'}。補齊後若帳戶餘額還是不同，才會再補一筆「餘額調整」，把零頭歸零（建議先把上面的漏記補完再用）。</p>
        <input className="input num" inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value.replace(/[^0-9.,]/g, ''))} placeholder={acc.isLiability ? '目前欠款' : '實際餘額'} aria-label="實際餘額" />
        {adjustTarget !== null && <p className="row-sub" style={{ whiteSpace: 'normal' }}>補齊後預計餘額 {money(expectedBalance)}，與你輸入的差 {money(Math.abs(remaining))}{remaining ? '，會補一筆餘額調整' : '，剛好對上 ✅'}</p>}
      </details>

      {needVerify && (missingSel.length > 0 || varSel.length > 0) && (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <span className="row-main">我已對照截圖確認上面的明細沒有讀錯</span>
          <Switch label="我已核對明細" checked={verified} onChange={setVerified} />
        </div>
      )}
      <button className="btn" style={{ marginTop: 12 }} disabled={busy || nothingToDo || (needVerify && (missingSel.length > 0 || varSel.length > 0) && !verified)} onClick={() => void apply()}>
        {busy ? '補齊中…' : nothingToDo ? '沒有需要補的項目' : `一鍵補齊並平帳（補記 ${missingSel.length} 筆${varSel.length ? `、差額 ${varSel.length} 筆` : ''}${adjustTarget !== null && remaining ? '、校正餘額' : ''}）`}
      </button>
      <button className="btn secondary" style={{ marginTop: 8 }} onClick={onDone}>完成</button>
    </>
  );
}
