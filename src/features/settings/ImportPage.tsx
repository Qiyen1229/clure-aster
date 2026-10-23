/**
 * CSV 匯入精靈：① 選檔 ② 欄位對應（自動辨識 Moze）③ 預覽與檢查 ④ 匯入
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseCSV } from '@/services/csv';
import { autoMap, FIELD_LABELS, parseRows, planImport, runImport, type FieldKey, type ImportPlan, type Mapping } from '@/services/importer';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';

export default function ImportPage() {
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [isMoze, setIsMoze] = useState(false);
  const [defAccount, setDefAccount] = useState('匯入帳戶');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const parsed = useMemo(() => (step >= 2 ? parseRows(body, mapping, { currency: base, account: defAccount }) : []), [step, rows, mapping, base, defAccount]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (f: File) => {
    const buf = await f.arrayBuffer();
    // 先試 UTF-8；出現大量亂碼時改用 Big5（舊版 Excel 匯出的中文 CSV）
    let text = new TextDecoder('utf-8').decode(buf);
    if ((text.match(/�/g)?.length ?? 0) > 5) { try { text = new TextDecoder('big5').decode(buf); } catch { /* 不支援 */ } }
    const r = parseCSV(text);
    if (r.length < 2) { useUI.getState().showSnack({ text: '檔案沒有資料列' }); return; }
    setRows(r);
    setFileName(f.name);
    const m = autoMap(r[0]);
    setMapping(m.mapping);
    setIsMoze(m.isMoze);
    setStep(1);
  };

  const preview = async () => {
    if (mapping.date === undefined || mapping.amount === undefined) { useUI.getState().showSnack({ text: '至少要對應「日期」與「金額」' }); return; }
    setStep(2);
    setPlan(await planImport(parseRows(body, mapping, { currency: base, account: defAccount })));
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => (step ? setStep(step - 1) : navigate(-1))}><Icon name="chevronL" /></button>
        <h1>匯入 CSV</h1>
        <div style={{ width: 44 }} />
      </header>
      <div className="steps">{[0, 1, 2, 3].map((i) => <i key={i} className={i === step ? 'on' : ''} />)}</div>

      {step === 0 && (
        <>
          <div className="card">
            <p style={{ marginTop: 0 }}><b>支援格式</b></p>
            <ul className="muted" style={{ paddingLeft: 20, fontSize: '0.9rem', lineHeight: 1.7 }}>
              <li><b>Moze</b>：Moze →「設定 → 匯出資料 → CSV」，自動辨識所有欄位，轉出／轉入會自動配對成轉帳</li>
              <li>其他記帳 App 或 Excel 匯出的 CSV（UTF-8 或 Big5），下一步可手動對應欄位</li>
              <li>找不到的帳戶、分類、標籤會自動建立；匯入完成後自動重算所有帳戶餘額</li>
            </ul>
            <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>建議先到「備份」匯出一份備份再匯入。</p>
          </div>
          <label className="btn" style={{ cursor: 'pointer' }}>
            選擇 CSV 檔
            <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onFile(f); }} />
          </label>
        </>
      )}

      {step === 1 && (
        <>
          <div className="card glass">
            <div><b>{fileName}</b></div>
            <div className="muted" style={{ fontSize: '0.85rem' }}>{body.length} 列資料{isMoze ? '・已辨識為 Moze 匯出格式 ✓' : ''}</div>
          </div>
          <div className="section-title">欄位對應</div>
          <div className="list">
            {(Object.keys(FIELD_LABELS) as FieldKey[]).map((k) => (
              <div key={k} className="field">
                <span className="label">{FIELD_LABELS[k]}</span>
                <select value={mapping[k] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [k]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                  <option value="">（不使用）</option>
                  {header.map((h, i) => <option key={i} value={i}>{h || `第 ${i + 1} 欄`}（例：{(body[0]?.[i] ?? '').slice(0, 12)}）</option>)}
                </select>
              </div>
            ))}
            {mapping.account === undefined && (
              <div className="field"><span className="label">預設帳戶</span><input value={defAccount} onChange={(e) => setDefAccount(e.target.value)} /></div>
            )}
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '0 8px 12px' }}>沒有「類型」欄位時：負數金額視為支出、正數視為收入。</p>
          <button className="btn" onClick={() => void preview()}>下一步：預覽</button>
        </>
      )}

      {step === 2 && plan && (
        <>
          <div className="card glass">
            <div className="stat-grid">
              <div className="stat"><div className="k">帳目</div><div className="v num">{plan.txs}</div></div>
              <div className="stat"><div className="k">轉帳</div><div className="v num">{plan.transfers}</div></div>
              <div className="stat"><div className="k">略過</div><div className="v num">{plan.skipped + plan.errors.length}</div></div>
            </div>
            {plan.newAccounts.length > 0 && <p style={{ fontSize: '0.85rem' }}>將建立帳戶：{plan.newAccounts.join('、')}</p>}
            {plan.newCategories.length > 0 && <p style={{ fontSize: '0.85rem' }}>將建立分類：{plan.newCategories.slice(0, 12).join('、')}{plan.newCategories.length > 12 ? ` 等 ${plan.newCategories.length} 個` : ''}</p>}
            {plan.skipped > 0 && <p className="muted" style={{ fontSize: '0.8rem' }}>「應收／應付款項」類型 {plan.skipped} 列會略過，可在「分帳」手動建立。</p>}
          </div>
          {plan.errors.length > 0 && (
            <>
              <div className="section-title">無法匯入的列（{plan.errors.length}）</div>
              <div className="list">{plan.errors.slice(0, 20).map((r) => <div key={r.line} className="row"><span className="num muted">第 {r.line} 列</span><span className="row-main">{r.error}</span></div>)}</div>
            </>
          )}
          <div className="section-title">預覽（前 15 列）</div>
          <div className="list">
            {parsed.filter((r) => !r.error).slice(0, 15).map((r) => (
              <div key={r.line} className="row">
                <div className="row-main">
                  <div className="row-title">{r.note || r.sub || r.main || '（無備註）'}</div>
                  <div className="row-sub">{r.date} · {r.kind === 'transfer_out' ? `轉出 ${r.account}` : r.kind === 'transfer_in' ? `轉入 ${r.account}` : `${r.main}${r.sub ? ` › ${r.sub}` : ''} · ${r.account}`}</div>
                </div>
                <span className="num">{r.kind === 'income' || r.kind === 'transfer_in' ? '+' : r.kind === 'adjust' ? '±' : '-'}{r.amount.abs().toString()} {r.currency}</span>
              </div>
            ))}
          </div>
          <button className="btn" disabled={busy || plan.txs + plan.transfers === 0} onClick={async () => {
            setBusy(true);
            try {
              const r = await runImport(parsed, base);
              useUI.getState().showSnack({ text: `匯入完成：${r.txs} 筆帳目、${r.transfers} 筆轉帳` });
              setStep(3);
            } catch (e) { useUI.getState().showSnack({ text: `匯入失敗：${(e as Error).message}` }); }
            finally { setBusy(false); }
          }}>{busy ? '匯入中…' : `確認匯入 ${plan.txs + plan.transfers} 筆`}</button>
        </>
      )}

      {step === 3 && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>🎉</div>
          <h3>匯入完成</h3>
          <p className="muted">帳戶餘額已依匯入的帳目重新計算。若期初餘額與實際不同，可到帳戶頁使用「調整餘額」。</p>
          <button className="btn" onClick={() => navigate('/ledger')}>查看帳目</button>
        </div>
      )}
    </main>
  );
}
