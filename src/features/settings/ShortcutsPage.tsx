/**
 * iPhone 捷徑設定頁面：
 * ① 加入 iPhone 捷徑（精靈引導）
 * ② 已連結的裝置（權杖列表與撤銷）
 * ③ 自訂捷徑權杖與手動設定指南
 * ④ 捷徑記帳設定（看得懂的直接記帳、卡片對應帳戶等）
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts } from '@/app/hooks';
import {
  createToken, ensureLink, forgetLink, hookUrl, listTokens, revokeToken, savedLink,
  deviceLabel, openShortcutImport, shortcutFileUrl, SHORTCUTS,
  type InboxToken,
} from '@/services/inbox';
import { useSettings } from '@/stores/settings';
import { useUI, ask, askInput } from '@/stores/ui';
import { AccountField, SwitchField } from '@/ui/form';
import { Icon, iconEmoji } from '@/ui/Icon';
import { ShortcutWizard } from '../inbox/ShortcutWizard';

const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });

async function copy(text: string, label: string) {
  try { await navigator.clipboard.writeText(text); snack(`已複製${label}`); } catch { snack('無法複製，請長按文字自行選取'); }
}

export default function ShortcutsPage() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.inbox);
  const set = useSettings((s) => s.set);
  const update = (patch: Partial<typeof cfg>) => set('inbox', { ...cfg, ...patch });
  const { list: accounts, map: accMap } = useAccounts();
  const [tokens, setTokens] = useState<InboxToken[] | null>(null);
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [link, setLink] = useState(savedLink);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    void listTokens().then((list) => {
      setTokens(list);
      const saved = savedLink();
      if (saved && !list.some((t) => t.id === saved.id)) { forgetLink(); setLink(null); }
    }, () => setTokens([]));
  }, []);

  const addShortcut = async (sc: (typeof SHORTCUTS)[number]) => {
    let l = link;
    let pending: ReturnType<typeof ensureLink> | null = null;
    let copying: Promise<boolean>;
    if (l) copying = navigator.clipboard.writeText(l.code).then(() => true, () => false);
    else {
      setPreparing(true);
      pending = ensureLink();
      copying = typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write
        ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': pending.then((x) => new Blob([x.code], { type: 'text/plain' })) })]).then(() => true, () => false)
        : Promise.resolve(false);
    }
    openShortcutImport(sc);
    let copied = await copying;
    if (pending) {
      try {
        const r = await pending;
        l = { id: r.id, code: r.code };
        setLink(l);
        if (r.created) setTokens((t) => [...(t ?? []), r.created!]);
        if (!copied) copied = await navigator.clipboard.writeText(r.code).then(() => true, () => false);
      } catch (e) { snack((e as Error).message); return; } finally { setPreparing(false); }
    }
    snack(copied
      ? '已複製連結碼：在「捷徑」App 按「設定捷徑」，長按輸入框 →「貼上」，最後按「加入捷徑」'
      : '請先複製下方的連結碼，再到「捷徑」App 貼上', 9000);
  };

  const resetLink = async () => {
    if (!link || !await ask('重新產生連結碼？已加入的捷徑會失效，需要重新加入。')) return;
    await revokeToken(link.id).catch(() => undefined);
    forgetLink();
    setTokens((l) => l?.filter((x) => x.id !== link.id) ?? null);
    setLink(null);
  };

  const sendTest = async (via: 'link' | 'header') => {
    const auth = via === 'header' && fresh ? { Authorization: `Bearer ${fresh.token}` } : null;
    const url = auth ? hookUrl() : link?.code;
    if (!url) return;
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ source: 'siri', text: '測試 午餐 120' }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `伺服器錯誤（${r.status}）`);
      snack('已送出測試項目，請至首頁「收件匣」查看待確認項目');
    } catch (e) { snack(`測試失敗：${(e as Error).message}`, 6000); }
  };

  const newToken = async () => {
    const name = await askInput({ title: '幫這組權杖取個名字', placeholder: '例如：我的 iPhone', defaultValue: '我的 iPhone', required: true, maxLength: 40, confirmText: '建立' });
    if (!name) return;
    try {
      const r = await createToken(name);
      setFresh({ token: r.token, name: r.item.name });
      setTokens((t) => [...(t ?? []), r.item]);
    } catch (e) { snack((e as Error).message); }
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>加入 iPhone 捷徑</h1>
        <div style={{ width: 36 }} />
      </header>

      <details className="card inbox-intro" open>
        <summary><b>⚡ 什麼是 iPhone 自動記帳捷徑？</b></summary>
        <p className="muted">設定好後，刷卡、網購、LINE Pay 掃碼付款或收到銀行通知時，iPhone 會自動將消費送進 Aster 收件匣，方便你在首頁隨時核對記帳。</p>
        <ol className="inbox-steps">
          <li><span>💳</span><div><b>照常付款</b><br />刷實體卡、網購、LINE Pay 掃碼，或對 Siri 說「記一筆，午餐 120」</div></li>
          <li><span>📨</span><div><b>捷徑自動寄出</b><br />銀行或支付 App 跳通知時，自動把金額、商家送進 Aster</div></li>
          <li><span>✅</span><div><b>首頁核對入帳</b><br />在首頁收件匣一鍵記帳，或開啟「看得懂的直接記帳」</div></li>
        </ol>
      </details>

      <div className="section-title">加入 iPhone 捷徑</div>
      <ShortcutWizard preparing={preparing} hasLink={!!link} onAdd={addShortcut} />
      <div className="card inbox-oneclick" style={{ marginTop: 10 }}>
        {link && (
          <div className="copy-row oneclick-code">
            <span className="label">連結碼</span><code>{link.code.replace(/t=(clr_.{4}).*(.{4})$/, 't=$1••••$2')}</code>
            <button className="pill" onClick={() => void copy(link.code, '連結碼')}>複製</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {link && <button className="btn tinted small" onClick={() => void sendTest('link')}>傳送測試項目</button>}
          {link && <button className="btn secondary small" onClick={() => void resetLink()}>重新產生連結碼</button>}
        </div>
        <details className="oneclick-fallback">
          <summary className="muted">沒有跳到「捷徑」App？</summary>
          <p className="muted">「加入」會切到「捷徑」App，匯入完按左上角「◀ Aster」回來。沒有跳轉的話，改下載捷徑檔，再到「檔案」App 的「下載項目」點開：</p>
          <p>{SHORTCUTS.map((s) => <a key={s.key} className="pill" href={shortcutFileUrl(s)} download={`${s.name}.shortcut`}>{s.name}</a>)}</p>
          <p className="muted">「設定捷徑」畫面卡住時，先按「略過設定」加入，再把捷徑第一個「文字」動作換成連結碼。外層有登入保護（如 Cloudflare Access）時，要放行 <code>/shortcuts/</code> 與 <code>/api/hook/</code>。</p>
        </details>
      </div>

      <div className="section-title">已連結的裝置</div>
      <div className="list">
        {tokens?.length === 0 && <div className="row"><span className="row-sub">還沒有。按上面的「加入」會自動建立。</span></div>}
        {tokens?.map((t) => (
          <div key={t.id} className="row">
            <span className="row-main">
              <span className="row-title">{link?.id === t.id && t.name === 'iPhone 捷徑' ? deviceLabel() : t.name} <span className="faint num">••••{t.hint}</span></span>
              <span className="row-sub">{t.last_used_at ? `已傳送 ${t.use_count || 1} 次資料，上次：${new Date(`${t.last_used_at}Z`).toLocaleString('zh-TW')}` : '還沒有送過資料'}</span>
            </span>
            <button className="pill" style={{ color: 'var(--danger)' }} onClick={async () => {
              if (!await ask(`撤銷「${t.name}」？使用這組權杖的捷徑將無法再送出。`)) return;
              try {
                await revokeToken(t.id);
                setTokens((l) => l?.filter((x) => x.id !== t.id) ?? null);
                if (link?.id === t.id) { forgetLink(); setLink(null); }
              } catch (e) { snack((e as Error).message); }
            }}>撤銷</button>
          </div>
        ))}
      </div>

      <details className="card inbox-advanced">
        <summary><b>進階：自己動手建立捷徑</b></summary>
        <p className="muted">想修改捷徑內容，或用在其他裝置（Android 的 Tasker 等）時，可以建立一組權杖，用標頭傳送。</p>
        <button className="btn secondary small" onClick={() => void newToken()}><Icon name="plus" /> 建立捷徑權杖</button>
        {fresh && (
          <div className="card inbox-token">
            <p style={{ marginTop: 0 }}><b>「{fresh.name}」的權杖已建立</b> — 只會顯示這一次，請現在複製到捷徑裡。</p>
            <div className="copy-row"><span className="label">網址</span><code>{hookUrl()}</code><button className="pill" onClick={() => void copy(hookUrl(), '網址')}>複製</button></div>
            <div className="copy-row"><span className="label">標頭值</span><code>Bearer {fresh.token}</code><button className="pill" onClick={() => void copy(`Bearer ${fresh.token}`, '標頭值')}>複製</button></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn tinted small" onClick={() => void sendTest('header')}>傳送測試項目</button>
              <button className="btn secondary small" onClick={() => setFresh(null)}>我已複製好了</button>
            </div>
          </div>
        )}
        <ShortcutGuides />
      </details>

      <div className="section-title">自動入帳偏好</div>
      <div className="list">
        <SwitchField label="看得懂的直接記帳" sub="開啟 App 時自動記下有金額且明確的項目。Apple Pay 偶爾會送來空白或被拒絕的交易，建議先手動確認一陣子再開啟"
          checked={cfg.autoBook} onChange={(v) => update({ autoBook: v })} />
        <AccountField label="判斷不出帳戶時" value={cfg.defaultAccountId} onChange={(v) => update({ defaultAccountId: v })} accounts={accounts}
          allowEmpty emptyLabel="上次記帳的帳戶" filter={(a) => a.type !== 'loan' && a.type !== 'brokerage'} />
      </div>
      {Object.keys(cfg.cardMap).length > 0 && (
        <>
          <div className="section-title">卡片對應的帳戶</div>
          <div className="list">
            {Object.entries(cfg.cardMap).map(([card, id]) => (
              <div key={card} className="field">
                <span className="label" style={{ flex: 1 }}>{card}</span>
                <select value={accMap.has(id) ? id : ''} aria-label={`${card} 對應的帳戶`}
                  onChange={(e) => {
                    const map = { ...cfg.cardMap };
                    if (e.target.value) map[card] = e.target.value; else delete map[card];
                    update({ cardMap: map });
                  }}>
                  <option value="">（不指定，自動判斷）</option>
                  {accounts.filter((a) => a.type !== 'loan').map((a) => <option key={a.id} value={a.id}>{iconEmoji(a.icon)} {a.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 8px' }}>確認記帳時會自動記住「哪張卡 → 哪個帳戶」，下次同一張卡就不用再選。</p>
        </>
      )}
    </main>
  );
}

/** 三種捷徑的設定步驟（可展開） */
function ShortcutGuides() {
  const common = (
    <>
      <li>加入動作「<b>取得 URL 的內容</b>」，網址貼上上面複製的<b>網址</b>。</li>
      <li>點「顯示更多」：<b>方法</b>選 POST；<b>標頭</b>新增一個，名稱填 <code>Authorization</code>，值貼上<b>標頭值</b>（Bearer 開頭那串）。</li>
      <li><b>要求本文</b>選「JSON」，再依下面的表格新增欄位（類型都選「文字」）。</li>
    </>
  );
  return (
    <div className="inbox-guides">
      <details className="card">
        <summary><b>💳 Apple Pay 付款後自動記帳</b><span className="faint">　iOS 17 以上</span></summary>
        <ol>
          <li>打開「捷徑」App →「自動化」→ 右上角「＋」→ 選「<b>交易</b>」。</li>
          <li>選要追蹤的卡片（可以全選），選「<b>立即執行</b>」，按「下一步」→「新增空白自動化」。</li>
          {common}
        </ol>
        <table className="inbox-fields"><tbody>
          <tr><td><code>source</code></td><td>applepay</td></tr>
          <tr><td><code>amount</code></td><td>點「捷徑輸入」→ 選「<b>金額</b>」</td></tr>
          <tr><td><code>merchant</code></td><td>「捷徑輸入」→「<b>商家</b>」</td></tr>
          <tr><td><code>card</code></td><td>「捷徑輸入」→「<b>卡片或票證</b>」（用來判斷帳戶）</td></tr>
        </tbody></table>
        <p className="muted">完成後用 Apple Pay 付一筆，打開 Aster 就會在收件匣看到。</p>
      </details>
      <details className="card">
        <summary><b>🔔 銀行 App／LINE Pay／街口通知自動記帳</b></summary>
        <ol>
          <li>打開「捷徑」App →「自動化」→ 右上角「＋」→ 選「<b>App 通知</b>」（或「App」）。</li>
          <li>「App」勾選你的銀行 App、LINE Pay、街口支付等，選「<b>立即執行</b>」，按「下一步」→「新增空白自動化」。</li>
          {common}
        </ol>
        <table className="inbox-fields"><tbody>
          <tr><td><code>source</code></td><td>notify</td></tr>
          <tr><td><code>card</code></td><td>點「捷徑輸入」→ 選「<b>App</b>」（傳送發送通知的 App 名稱）</td></tr>
          <tr><td><code>text</code></td><td>點「捷徑輸入」→ 選「<b>內容</b>」</td></tr>
        </tbody></table>
        <p className="muted">Aster 會從通知文字中解析金額、商店名稱與卡片帳戶，非交易的驗證碼與廣告推播會自動過濾略過。</p>
      </details>
      <details className="card">
        <summary><b>🎙 對 Siri 說一句話記帳</b></summary>
        <ol>
          <li>「捷徑」→ 右上角「＋」新增捷徑，名稱取「<b>記一筆</b>」（這就是對 Siri 說的話）。</li>
          <li>加入動作「<b>聽寫文字</b>」，語言選「中文（台灣）」。</li>
          {common}
        </ol>
        <table className="inbox-fields"><tbody>
          <tr><td><code>source</code></td><td>siri</td></tr>
          <tr><td><code>text</code></td><td>選「<b>聽寫的文字</b>」</td></tr>
        </tbody></table>
        <p className="muted">說「嘿 Siri，記一筆」，再說「昨天午餐 150 刷玉山卡」或「早餐 60 午餐 120」，一句話可以記好幾筆。</p>
      </details>
    </div>
  );
}
