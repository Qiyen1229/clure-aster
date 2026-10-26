/**
 * 電子發票：① 拍紙本發票左側 QR Code → 預填記帳面板 ② 匯入財政部手機條碼載具的消費明細 CSV（批次記帳、自動分類、跳過已記過的發票）
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts } from '@/app/hooks';
import {
  existingInvoiceNos, importInvoices, invoiceNote, isVoided, parseEinvoiceCsv, scanInvoiceImage, type Invoice,
} from '@/services/einvoice';
import { suggestCategory } from '@/services/autocat';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { AccountField } from '@/ui/form';
import { Icon } from '@/ui/Icon';

export default function InvoicePage() {
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const lastAccountId = useSettings((s) => s.lastAccountId);
  const { list: accounts } = useAccounts();
  const [busy, setBusy] = useState('');
  const [list, setList] = useState<Invoice[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [accountId, setAccountId] = useState('');
  const acc = accounts.find((a) => a.id === (accountId || lastAccountId)) ?? accounts.find((a) => !a.archived);
  const snack = (text: string) => useUI.getState().showSnack({ text });

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
      const sug = note ? await suggestCategory(note, 'expense') : null;
      useUI.getState().openAdd({
        mode: 'expense', amount: String(invoice.amount), date: invoice.date, note, invoiceNo: invoice.number,
        categoryId: sug?.categoryId, tagIds: sug?.tagIds.length ? sug.tagIds : undefined, accountId: acc?.id,
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

      <div className="section-title">記帳帳戶</div>
      <div className="list">
        <AccountField value={acc?.id ?? ''} onChange={setAccountId} accounts={accounts} />
      </div>

      <div className="section-title">掃描紙本發票</div>
      <div className="list">
        <label className="row accent" style={{ cursor: 'pointer' }}>
          <Icon name="camera" />
          <span className="row-main">{busy === 'scan' ? '辨識中…' : '拍攝發票左側 QR Code'}</span>
          <input type="file" accept="image/*" className="sr-only" disabled={!!busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onScan(f); }} />
        </label>
        <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>會自動帶入金額、日期、品名與發票號碼，並依「自動分類規則」選分類；確認後按完成即可。</span></div>
      </div>

      <div className="section-title">匯入手機條碼載具</div>
      <div className="list">
        <label className="row accent" style={{ cursor: 'pointer' }}>
          <Icon name="download" />
          <span className="row-main">選擇消費明細 CSV</span>
          <input type="file" accept=".csv,text/csv,text/plain" className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onCsv(f); }} />
        </label>
        <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>
          到財政部電子發票整合服務平台，以手機條碼登入 →「消費明細查詢」→ 匯出 CSV。已記過的發票號碼與作廢發票會自動略過。
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
          <button className="btn" disabled={!todo.length || !acc || !!busy} onClick={async () => {
            setBusy('import');
            try {
              const n = await importInvoices(todo, acc!.id, acc!.currency || base);
              snack(`已記帳 ${n} 張發票`);
              setDone(await existingInvoiceNos(list.map((x) => x.number)));
            } catch (e) { snack(`匯入失敗：${(e as Error).message}`); } finally { setBusy(''); }
          }}>{busy === 'import' ? '匯入中…' : `記帳 ${todo.length} 張到「${acc?.name ?? ''}」`}</button>
        </>
      )}
    </main>
  );
}
