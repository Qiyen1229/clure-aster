/**
 * Email 轉寄收帳單（方案 A）的設定：建立專用權杖、複製收信管道（Cloudflare Email Worker）要貼的網址與程式碼、
 * 設定寄件人白名單、傳送測試信。Aster 不會拿到你的信箱帳號密碼，只收你主動轉寄過來的信。
 */
import { useEffect, useState } from 'react';
import { CLOUDFLARE_WORKER_CODE, createMailToken, listTokens, mailHookUrl, MAIL_TOKEN_NAME, revokeToken, setAllowFrom, type InboxToken } from '@/services/inbox';
import { useUI, ask } from '@/stores/ui';
import { Icon } from '@/ui/Icon';

const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });
async function copy(text: string, label: string) {
  try { await navigator.clipboard.writeText(text); snack(`已複製${label}`); } catch { snack('無法複製，請長按文字自行選取'); }
}

export function MailSetup() {
  const [token, setToken] = useState<InboxToken | null | undefined>(undefined);
  const [fresh, setFresh] = useState<string | null>(null);
  const [allow, setAllow] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => listTokens().then((l) => {
    const t = l.find((x) => x.name === MAIL_TOKEN_NAME) ?? null;
    setToken(t);
    setAllow(t?.allow_from ?? '');
  }, () => setToken(null));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const r = await createMailToken();
      setFresh(r.token);
      setToken(r.item);
      setAllow('');
    } catch (e) { snack((e as Error).message); } finally { setBusy(false); }
  };
  const revoke = async () => {
    if (!token || !await ask('撤銷這組 Email 轉寄權杖？收信管道要換成新的權杖才能繼續送信。')) return;
    try { await revokeToken(token.id); setToken(null); setFresh(null); } catch (e) { snack((e as Error).message); }
  };
  const saveAllow = async () => {
    if (!token) return;
    try { const t = await setAllowFrom(token.id, allow); setToken(t); setAllow(t.allow_from ?? ''); snack(t.allow_from ? '已儲存寄件人白名單' : '已清除白名單（不限寄件人）'); } catch (e) { snack((e as Error).message); }
  };
  /** 送一封測試信（JSON 格式，和收信管道送的整封信走同一個入口）：打開上面的待確認清單就看得到 */
  const sendTest = async () => {
    if (!fresh) return;
    try {
      const r = await fetch(mailHookUrl(), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fresh}` },
        body: JSON.stringify({ from: 'Aster 測試 <test@example.com>', subject: 'Aster 測試信', text: '這是一封測試信：收信管道設定好之後，銀行的電子帳單信就會像這樣出現在收件匣。' }),
      });
      const j = await r.json().catch(() => null) as { ok?: boolean; message?: string; detail?: string } | null;
      if (!r.ok) throw new Error(j?.detail ?? `伺服器錯誤（${r.status}）`);
      snack(j?.message ?? '已送出測試信，請看上方的待確認清單');
    } catch (e) { snack(`測試失敗：${(e as Error).message}`, 6000); }
  };

  return (
    <details className="card inbox-advanced">
      <summary><b>✉️ Email 轉寄收帳單</b><span className="faint">　銀行電子帳單自動進收件匣</span></summary>
      <p className="muted">把銀行寄來的電子帳單信，用信箱的「自動轉寄」轉到你自己的收信地址；Aster 收到後放進收件匣，帳單附件（CSV、截圖）可以一鍵帶進「對帳」。
        <b> Aster 不會拿到你信箱的帳號密碼</b>，只收你主動轉寄的信。</p>
      <ol className="inbox-steps">
        <li><span>1</span><div><b>建立轉寄權杖</b><br />下面按一下，取得網址與權杖（權杖只會顯示一次）</div></li>
        <li><span>2</span><div><b>設定收信管道</b><br />用 Cloudflare 免費的 Email Routing：建一個收信地址，轉給「Email Worker」，貼上下面的程式碼與兩個變數</div></li>
        <li><span>3</span><div><b>在信箱設轉寄規則</b><br />Gmail／Outlook 設一條規則：寄件人是銀行的信，自動轉寄到那個收信地址</div></li>
      </ol>

      {token === undefined ? <p className="muted">載入中…</p> : token === null ? (
        <button className="btn secondary small" disabled={busy} onClick={() => void create()}><Icon name="plus" /> 建立 Email 轉寄權杖</button>
      ) : (
        <div className="card inbox-token">
          <p style={{ marginTop: 0 }}>
            <b>Email 轉寄權杖</b> <span className="faint num">••••{token.hint}</span><br />
            <span className="row-sub">{token.last_used_at ? `上次收到信：${new Date(`${token.last_used_at}Z`).toLocaleString('zh-TW')}` : '還沒有收到過信'}</span>
          </p>
          {fresh ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>權杖只會顯示這一次，請現在複製到 Cloudflare Worker 的機密變數。</p>
              <div className="copy-row"><span className="label">ASTER_URL</span><code>{mailHookUrl()}</code><button className="pill" onClick={() => void copy(mailHookUrl(), '網址')}>複製</button></div>
              <div className="copy-row"><span className="label">ASTER_TOKEN</span><code>{fresh}</code><button className="pill" onClick={() => void copy(fresh, '權杖')}>複製</button></div>
            </>
          ) : <p className="muted" style={{ marginTop: 0 }}>權杖已建立。要重新取得網址與權杖，請撤銷後重新建立。</p>}
          <div className="copy-row"><span className="label">Worker 程式碼</span><code>message/rfc822 → Aster</code><button className="pill" onClick={() => void copy(CLOUDFLARE_WORKER_CODE, 'Worker 程式碼')}>複製</button></div>
          <label className="field" style={{ margin: '10px 0 0' }}>
            <span className="label" style={{ flex: 'none', width: 'auto' }}>只收這些寄件人</span>
            <input value={allow} placeholder="例如 esunbank.com.tw, cathaybk.com.tw（空白＝不限）" maxLength={400} onChange={(e) => setAllow(e.target.value)} aria-label="寄件人白名單" />
            <button className="pill" onClick={() => void saveAllow()}>儲存</button>
          </label>
          <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 0 8px' }}>填網域或完整地址，逗號分隔，子網域也算。建議填，可以擋掉垃圾信；不在名單的信會被略過、不會進收件匣。</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {fresh && <button className="btn tinted small" onClick={() => void sendTest()}>傳送測試信</button>}
            <button className="btn secondary small" style={{ color: 'var(--danger)' }} onClick={() => void revoke()}>撤銷權杖</button>
          </div>
        </div>
      )}
      <details className="oneclick-fallback">
        <summary className="muted">要注意的事</summary>
        <ul className="muted" style={{ paddingLeft: 18, lineHeight: 1.6 }}>
          <li><b>PDF 帳單</b>：多數銀行的 PDF 有密碼，Aster 不解析 PDF；信會進收件匣、可下載 PDF，要對帳請用銀行網銀匯出 CSV，或把帳單截圖（每張 2 點 AI 額度）。附件只收 CSV（1 MB）、截圖（3 MB）、PDF（4 MB），一封信最多 3 個。</li>
          <li><b>帳單信不會自動記帳</b>：信裡的「應繳金額」不是一筆消費，所以帳單信不會被自動入帳；有消費明細的通知信才會解析出一筆草稿。</li>
          <li><b>Gmail 轉寄要先驗證</b>：Gmail 設定轉寄地址時會寄一封確認信到那個地址，那封信會出現在這裡的收件匣，把裡面的驗證碼貼回 Gmail。</li>
          <li><b>隱私</b>：暫存的信件內容沒有端對端加密（收信管道沒有你的加密密碼）；處理或略過後立即刪除，30 天沒處理也會自動清除。經過 Cloudflare 轉送是這個方案的代價，不想經過第三方的人可以只用上面的捷徑。</li>
          <li>設定白名單後，寄件人偽造無法完全排除——所以所有信都只會變成「待確認」，要你按了才會記帳。</li>
        </ul>
      </details>
    </details>
  );
}
