/**
 * 電子發票：
 * ① 手機條碼載具：輸入手機條碼與驗證碼，開啟 App 時自動抓新發票記帳（伺服器需設定財政部 AppID）
 * ② 無法判斷付款帳戶時的預設帳戶（三種方式共用；也可在自動分類規則指定帳戶）
 * ③ 拍紙本發票左側 QR Code → 預填記帳面板
 * ④ 匯入財政部載具消費明細 CSV（沒有 AppID 時的替代方式）
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts } from '@/app/hooks';
import {
  existingInvoiceNos, importInvoices, invoiceNote, isVoided, parseEinvoiceCsv, scanInvoiceImage, type Invoice, type InvoiceImportResult,
} from '@/services/einvoice';
import { CARD_NO_RE, carrierServerStatus, syncCarrier } from '@/services/carrier';
import { suggestAccount, suggestCategory } from '@/services/autocat';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { AccountField, SwitchField } from '@/ui/form';
import { Icon } from '@/ui/Icon';

const summary = (r: InvoiceImportResult) =>
  [`新記 ${r.created} 筆`, r.matched ? `對到 ${r.matched} 筆手動記帳` : '', r.skipped ? `略過 ${r.skipped} 張（已記過或作廢）` : '',
    r.usedDefault ? `${r.usedDefault} 筆記到預設帳戶` : ''].filter(Boolean).join('、');

export default function InvoicePage() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.einvoice);
  const set = useSettings((s) => s.set);
  const { list: accounts } = useAccounts();
  const [busy, setBusy] = useState('');
  const [list, setList] = useState<Invoice[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [server, setServer] = useState<{ configured: boolean; message: string } | null>(null);
  const [cardNo, setCardNo] = useState(cfg.cardNo);
  const [code, setCode] = useState(cfg.verifyCode);
  const [lastResult, setLastResult] = useState('');
  const payable = accounts.filter((a) => a.type !== 'loan' && a.type !== 'brokerage');
  const defaultAcc = payable.find((a) => a.id === cfg.defaultAccountId) ?? payable.find((a) => !a.isLiability) ?? payable[0];
  const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });
  const update = (patch: Partial<typeof cfg>) => set('einvoice', { ...cfg, ...patch });

  useEffect(() => { void carrierServerStatus().then(setServer); }, []);

  const cardValid = CARD_NO_RE.test(cardNo);
  const saveCarrier = () => {
    if (!cardValid) { snack('手機條碼格式為「/」加 7 碼英數字，例如 /ABC1234'); return; }
    if (code.length < 4) { snack('請輸入手機條碼驗證碼'); return; }
    update({ cardNo, verifyCode: code, defaultAccountId: cfg.defaultAccountId || defaultAcc?.id || '' });
    snack('已儲存載具');
  };

  const runSync = async () => {
    setBusy('sync');
    try {
      const r = await syncCarrier({ force: true });
      if (!r) { snack('請先儲存手機條碼與驗證碼'); return; }
      const text = `${r.start}～${r.end} 共 ${r.fetched} 張：${summary(r)}`;
      setLastResult(text);
      snack(text, 7000);
    } catch (e) { snack((e as Error).message, 7000); } finally { setBusy(''); }
  };

  const onScan = async (f: File) => {
    setBusy('scan');
    try {
      const { invoice, raw } = await scanInvoiceImage(f);
      if (!invoice) {
        snack(raw?.startsWith('**') ? '讀到的是右側 QR Code，請拍左側（或兩個一起入鏡）' : '找不到發票 QR Code，請拍清楚一點、避免反光');
        return;
      }
      if ((await existingInvoiceNos([invoice.number])).has(invoice.number)) {
        if (!window.confirm(`發票 ${invoice.number} 已經記過帳，仍要再記一筆？`)) return;
      }
      const note = invoiceNote(invoice);
      const [sug, acc] = await Promise.all([note ? suggestCategory(note, 'expense') : null, note ? suggestAccount(note) : undefined]);
      useUI.getState().openAdd({
        mode: 'expense', amount: String(invoice.amount), date: invoice.date, note, invoiceNo: invoice.number,
        categoryId: sug?.categoryId, tagIds: sug?.tagIds.length ? sug.tagIds : undefined, accountId: acc?.accountId ?? defaultAcc?.id,
      });
    } catch (e) {
      snack(`無法讀取圖片：${(e as Error).message}`);
    } finally { setBusy(''); }
  };

  const onCsv = async (f: File) => {
    const buf = await f.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if ((text.match(/�/g)?.length ?? 0) > 5) { try { text = new TextDecoder('big5').decode(buf); } catch { /* 不支援 */ } }
    const inv = parseEinvoiceCsv(text);
    if (!inv.length) { snack('檔案中找不到發票資料，請確認是財政部載具的消費明細匯出檔'); return; }
    setList(inv.sort((a, b) => b.date.localeCompare(a.date)));
    setDone(await existingInvoiceNos(inv.map((i) => i.number)));
  };

  const todo = list.filter((i) => !done.has(i.number) && !isVoided(i) && i.amount > 0);

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>電子發票</h1>
        <div style={{ width: 44 }} />
      </header>

      <div className="section-title">對獎</div>
      <div className="list">
        <button className="row accent" onClick={() => navigate('/settings/invoice/prize')}>
          <span className="row-main">🎉 統一發票對獎<span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>每期開獎後自動拿你記過的發票對獎，中了一鍵記成收入</span></span>
          <Icon name="chevronR" className="row-chev" />
        </button>
      </div>

      <div className="section-title">手機條碼載具</div>
      <div className="list">
        <div className="field">
          <label htmlFor="ei-card">手機條碼</label>
          <input id="ei-card" value={cardNo} placeholder="/ABC1234" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={8}
            onChange={(e) => { const v = e.target.value.toUpperCase().replace(/\s/g, ''); setCardNo(v && !v.startsWith('/') ? `/${v}` : v); }} />
        </div>
        <div className="field">
          <label htmlFor="ei-code">驗證碼</label>
          <input id="ei-code" type="password" value={code} autoComplete="off" maxLength={16} placeholder="手機條碼驗證碼" onChange={(e) => setCode(e.target.value.trim())} />
        </div>
        {(cardNo !== cfg.cardNo || code !== cfg.verifyCode) && (
          <button className="row accent" onClick={saveCarrier}>儲存載具</button>
        )}
        {server?.configured && cfg.cardNo && (
          <>
            <SwitchField label="開啟 App 時自動記帳" sub="抓取新的雲端發票，依規則與過去記帳判斷分類和帳戶" checked={cfg.autoSync} onChange={(v) => update({ autoSync: v })} />
            <button className="row accent" disabled={!!busy} onClick={() => void runSync()}>{busy === 'sync' ? '向財政部查詢中…' : '立即抓取發票並記帳'}</button>
          </>
        )}
        {lastResult && <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>{lastResult}</span></div>}
        {cfg.cardNo && cardNo === cfg.cardNo && code === cfg.verifyCode && (
          <button className="row danger" style={{ color: 'var(--danger)' }} onClick={() => {
            if (!window.confirm('移除這個手機條碼與驗證碼？已記的帳目不受影響。')) return;
            update({ cardNo: '', verifyCode: '' });
            setCardNo('');
            setCode('');
            setLastResult('');
          }}>移除載具</button>
        )}
      </div>
      {server && !server.configured && (
        <div className="card" style={{ fontSize: '0.85rem' }}>
          <p style={{ marginTop: 0 }}><b>目前無法自動抓取載具發票</b></p>
          <p className="muted">自動抓取要透過財政部「電子發票應用 API」，需要在伺服器設定財政部核發的 AppID（.env 的 <code>CLURE_EINVOICE_APP_ID</code>）。財政部自 112 年 3 月起只受理通過 ISO 27001 等資安認證的企業或組織申請，個人通常無法取得。</p>
          <p className="muted" style={{ marginBottom: 0 }}>載具資料會先保存好；請先用下方的「掃描紙本發票」或「匯入消費明細 CSV」，記帳時同樣會套用預設帳戶與自動分類。</p>
        </div>
      )}

      <div className="section-title">記到哪個帳戶</div>
      <div className="list">
        <AccountField label="預設帳戶" value={defaultAcc?.id ?? ''} onChange={(v) => update({ defaultAccountId: v })} accounts={accounts}
          filter={(a) => a.type !== 'loan' && a.type !== 'brokerage'} />
        <button className="row" onClick={() => navigate('/settings/rules')}>
          <span className="row-main"><span className="row-title">依商家指定帳戶</span>
            <span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>先看自動分類規則有沒有指定帳戶（例如「全聯」→ 全支付），再看你過去在同一商家最常用的帳戶；都判斷不出來才記到預設帳戶</span></span>
          <Icon name="chevronR" className="row-chev" />
        </button>
      </div>

      <div className="section-title">掃描紙本發票</div>
      <div className="list">
        <label className="row accent" style={{ cursor: 'pointer' }}>
          <Icon name="camera" />
          <span className="row-main">{busy === 'scan' ? '辨識中…' : '拍攝發票左側 QR Code'}</span>
          <input type="file" accept="image/*" className="sr-only" disabled={!!busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onScan(f); }} />
        </label>
      </div>

      <div className="section-title">匯入載具消費明細</div>
      <div className="list">
        <label className="row accent" style={{ cursor: 'pointer' }}>
          <Icon name="download" />
          <span className="row-main">選擇消費明細 CSV</span>
          <input type="file" accept=".csv,text/csv,text/plain" className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onCsv(f); }} />
        </label>
        <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>
          到財政部電子發票整合服務平台，以手機條碼登入 →「消費明細查詢」→ 匯出 CSV。已記過的發票號碼、作廢發票會略過；手動記過的同一筆會補上發票號碼而不重複記帳。
        </span></div>
      </div>

      {list.length > 0 && (
        <>
          <div className="section-title">共 {list.length} 張・待記帳 {todo.length} 張</div>
          <div className="list">
            {list.slice(0, 100).map((i) => {
              const skip = done.has(i.number) ? '已記帳' : isVoided(i) ? i.status : '';
              return (
                <div key={i.number} className="row" style={skip ? { opacity: 0.5 } : undefined}>
                  <div className="row-main">
                    <div className="row-title">{i.sellerName || i.sellerId || i.number}</div>
                    <div className="row-sub">{i.date} · {i.number}{invoiceNote(i) ? ` · ${invoiceNote(i)}` : ''}{skip ? ` · ${skip}` : ''}</div>
                  </div>
                  <span className="num">{i.amount.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
          <button className="btn" disabled={!todo.length || !defaultAcc || !!busy} onClick={async () => {
            setBusy('import');
            try {
              const r = await importInvoices(todo, { defaultAccountId: defaultAcc!.id });
              snack(summary(r), 7000);
              setDone(await existingInvoiceNos(list.map((x) => x.number)));
            } catch (e) { snack(`匯入失敗：${(e as Error).message}`); } finally { setBusy(''); }
          }}>{busy === 'import' ? '匯入中…' : `記帳 ${todo.length} 張`}</button>
        </>
      )}
    </main>
  );
}
