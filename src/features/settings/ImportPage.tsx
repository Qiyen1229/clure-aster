/**
 * CSV 匯入精靈：① 選檔 ② 欄位對應（自動辨識 Moze、套用已存的銀行格式）③ 預覽與檢查（疑似重複、自動分類）④ 匯入
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseCSV } from '@/services/csv';
import {
  autoMap, enrichRows, FIELD_LABELS, headerSignature, parseRows, planImport, runImport, type FieldKey, type ImportPlan, type Mapping, type ParsedRow,
} from '@/services/importer';
import { uid } from '@/db/schema';
import { categoryLabel, useAccounts, useCategories } from '@/app/hooks';
import { SwitchField } from '@/ui/form';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';

/** 帳戶名稱建議（匯入到既有帳戶） */
function AccountNames() {
  const { list } = useAccounts();
  return <datalist id="import-accounts">{list.map((a) => <option key={a.id} value={a.name} />)}</datalist>;
}

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
  const [positiveIsExpense, setPositiveIsExpense] = useState(false);
  const [skipDups, setSkipDups] = useState(true);
  const [enriched, setEnriched] = useState<ParsedRow[]>([]);
  const [profileName, setProfileName] = useState('');
  const profiles = useSettings((s) => s.importProfiles);
  const { map: catMap } = useCategories();
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const parsed = useMemo(() => enriched.filter((r) => !(skipDups && r.dup)), [enriched, skipDups]);
  useEffect(() => { if (step === 2) void planImport(parsed).then(setPlan); }, [parsed, step]);

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
    const saved = useSettings.getState().importProfiles.find((p) => p.header === headerSignature(r[0]));
    if (saved && !m.isMoze) {
      setMapping(saved.mapping);
      setDefAccount(saved.defAccount);
      setPositiveIsExpense(saved.positiveIsExpense);
      setProfileName(saved.name);
      useUI.getState().showSnack({ text: `已套用格式「${saved.name}」` });
    } else {
      setMapping(m.mapping);
      setProfileName('');
    }
    setIsMoze(m.isMoze);
    setStep(1);
  };

  const preview = async () => {
    const hasAmount = mapping.amount !== undefined || mapping.debit !== undefined || mapping.credit !== undefined;
    if (mapping.date === undefined || !hasAmount) { useUI.getState().showSnack({ text: '至少要對應「日期」與「金額」（或支出／存入金額）' }); return; }
    setBusy(true);
    try {
      setPlan(null);
      setEnriched(await enrichRows(parseRows(body, mapping, { currency: base, account: defAccount }, { positiveIsExpense })));
      setStep(2);
    } finally { setBusy(false); }
  };

  const saveProfile = () => {
    const name = profileName.trim() || window.prompt('格式名稱（例如：玉山信用卡）', fileName.replace(/\.csv$/i, ''))?.trim();
    if (!name) return;
    const sig = headerSignature(header);
    const rest = profiles.filter((p) => p.header !== sig);
    useSettings.getState().set('importProfiles', [...rest, { id: uid(), name, header: sig, mapping, defAccount, positiveIsExpense }]);
    setProfileName(name);
    useUI.getState().showSnack({ text: `已儲存格式「${name}」，下次匯入同樣欄位的檔案會自動套用` });
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
              <li><b>銀行／信用卡對帳單</b>：網銀下載的 CSV；支出與存入分兩欄、民國年日期都支援，疑似重複的帳目會自動略過，沒有分類時依「自動分類規則」帶入</li>
              <li><b>電子發票</b>：請改用「設定 → 電子發票匯入」</li>
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
              <div className="field"><span className="label">匯入到帳戶</span><input value={defAccount} onChange={(e) => setDefAccount(e.target.value)} list="import-accounts" aria-label="匯入到帳戶" /></div>
            )}
            {mapping.type === undefined && mapping.amount !== undefined && (
              <SwitchField label="正數代表支出" sub="信用卡帳單通常以正數表示消費、負數表示退款" checked={positiveIsExpense} onChange={setPositiveIsExpense} />
            )}
          </div>
          <AccountNames />
          <p className="muted" style={{ fontSize: '0.8rem', margin: '0 8px 12px' }}>沒有「類型」欄位時：負數金額視為支出、正數視為收入（可用上方開關反轉）。帳戶名稱與現有帳戶相同時直接記入，否則會建立新帳戶。</p>
          {!isMoze && <button className="btn tinted" style={{ marginBottom: 8 }} onClick={saveProfile}>{profileName ? `更新格式「${profileName}」` : '把這個欄位對應存成格式'}</button>}
          <button className="btn" disabled={busy} onClick={() => void preview()}>{busy ? '檢查中…' : '下一步：預覽'}</button>
        </>
      )}

      {step === 2 && plan && (
        <>
          <div className="card glass">
            <div className="stat-grid">
              <div className="stat"><div className="k">帳目</div><div className="v num">{plan.txs}</div></div>
              <div className="stat"><div className="k">轉帳</div><div className="v num">{plan.transfers}</div></div>
              <div className="stat"><div className="k">略過</div><div className="v num">{plan.skipped + plan.errors.length + (skipDups ? enriched.filter((r) => r.dup && !r.error).length : 0)}</div></div>
            </div>
            {enriched.some((r) => r.dup && !r.error) && (
              <SwitchField label={`略過疑似重複（${enriched.filter((r) => r.dup && !r.error).length} 筆）`} sub="同帳戶、同金額、日期相差一天內已有帳目" checked={skipDups} onChange={setSkipDups} />
            )}
            {enriched.some((r) => r.autoCategoryId) && <p style={{ fontSize: '0.85rem' }}>🪄 {enriched.filter((r) => r.autoCategoryId).length} 筆依規則／過去記帳自動分類</p>}
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
                  <div className="row-sub">{r.date} · {r.kind === 'transfer_out' ? `轉出 ${r.account}` : r.kind === 'transfer_in' ? `轉入 ${r.account}` : `${r.main ? `${r.main}${r.sub ? ` › ${r.sub}` : ''}` : r.autoCategoryId ? `🪄 ${categoryLabel(catMap, r.autoCategoryId)}` : '其他'} · ${r.account}`}{r.dup ? ` · ⚠️ 疑似重複（${r.dup}）` : ''}</div>
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
