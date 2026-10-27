/**
 * 自動記帳收件匣：
 * ① 這是什麼（第一次使用時展開）
 * ② 待確認：iPhone 捷徑送來的 Apple Pay 交易、銀行簡訊、Siri 一句話 → 一鍵記帳、編輯後記帳、略過
 * ③ 設定捷徑：建立捷徑專用權杖、三種捷徑的設定步驟、傳送測試
 * ④ 記帳方式：自動入帳、預設帳戶、卡片對應的帳戶
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts, useCategories } from '@/app/hooks';
import { formatMoney, toMinor } from '@/domain/money';
import { shortDate } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { deleteTransactions, deleteTransfers } from '@/db/repo/ledger';
import {
  ackInbox, bookInboxEntries, createToken, hookUrl, listTokens, loadInbox, revokeToken, SOURCE_LABEL, useInboxCount,
  type InboxEntry, type InboxToken,
} from '@/services/inbox';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { AccountField, SwitchField } from '@/ui/form';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';

const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });

async function copy(text: string, label: string) {
  try { await navigator.clipboard.writeText(text); snack(`已複製${label}`); } catch { snack('無法複製，請長按文字自行選取'); }
}

export default function InboxPage() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.inbox);
  const set = useSettings((s) => s.set);
  const update = (patch: Partial<typeof cfg>) => set('inbox', { ...cfg, ...patch });
  const { list: accounts, map: accMap } = useAccounts();
  const { map: catMap } = useCategories();
  const count = useInboxCount((s) => s.n);
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [error, setError] = useState('');
  const [tokens, setTokens] = useState<InboxToken[] | null>(null);
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayKey();

  const reload = useCallback(async () => {
    try { setEntries(await loadInbox()); setError(''); } catch (e) { setError((e as Error).message); setEntries([]); }
  }, []);
  useEffect(() => { void reload(); }, [reload, count]);
  useEffect(() => { void listTokens().then(setTokens, () => setTokens([])); }, []);

  const firstTime = tokens !== null && tokens.length === 0 && !entries?.length;
  const ready = entries?.filter((e) => e.drafts.length) ?? [];

  const book = async (list: InboxEntry[]) => {
    setBusy(true);
    try {
      const r = await bookInboxEntries(list);
      snackUndo(`已記下 ${r.count} 筆${r.skipped ? `（${r.skipped} 筆已在其他裝置處理）` : ''}`, async () => {
        if (r.txIds.length) await deleteTransactions(r.txIds);
        if (r.transferIds.length) await deleteTransfers(r.transferIds);
      });
      await reload();
    } catch (e) { snack((e as Error).message); } finally { setBusy(false); }
  };

  const skip = async (e: InboxEntry) => {
    await ackInbox([e.item.id]).catch((err) => snack((err as Error).message));
    setEntries((l) => l?.filter((x) => x.item.id !== e.item.id) ?? null);
  };

  const edit = (e: InboxEntry) => {
    const d = e.drafts[0];
    const base = { inboxId: String(e.item.id), inboxCard: e.item.card || undefined };
    if (e.drafts.length > 1) useUI.getState().openAdd({ ...base, quickText: e.item.text });
    else if (d) {
      useUI.getState().openAdd({
        ...base, mode: d.kind, amount: String(d.amount), date: d.date, accountId: d.accountId, toAccountId: d.toAccountId,
        categoryId: d.categoryId, note: d.note, tagIds: d.tagIds.length ? d.tagIds : undefined, merchant: e.item.merchant || undefined,
      });
    } else useUI.getState().openAdd({ ...base, note: (e.item.merchant || e.item.text).slice(0, 200) });
  };

  const newToken = async () => {
    const name = window.prompt('幫這組權杖取個名字（例如：我的 iPhone）', '我的 iPhone');
    if (!name?.trim()) return;
    try {
      const r = await createToken(name.trim());
      setFresh({ token: r.token, name: r.item.name });
      setTokens((t) => [...(t ?? []), r.item]);
    } catch (e) { snack((e as Error).message); }
  };

  const sendTest = async () => {
    if (!fresh) return;
    try {
      const r = await fetch(hookUrl(), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fresh.token}` },
        body: JSON.stringify({ source: 'siri', text: '測試 午餐 120' }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `伺服器錯誤（${r.status}）`);
      snack('已送出測試項目，請看上方的待確認清單');
      await reload();
    } catch (e) { snack(`測試失敗：${(e as Error).message}`, 6000); }
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>收件匣</h1>
        <button className="icon-btn" aria-label="重新整理" onClick={() => void reload()}><Icon name="repeat" /></button>
      </header>

      <details className="card inbox-intro" open={firstTime}>
        <summary><b>📥 收件匣是什麼？</b></summary>
        <p className="muted">把它想成「記帳專用的信箱」。iPhone 的「捷徑」App 會在你付款或收到通知時，自動把內容寄到這裡，你打開 Clure 確認一下就記好帳了。</p>
        <ol className="inbox-steps">
          <li><span>💳</span><div><b>你照常付款</b><br />用 Apple Pay 刷卡、收到銀行刷卡簡訊，或對 Siri 說「記一筆，午餐 120」</div></li>
          <li><span>📨</span><div><b>捷徑自動寄出</b><br />iPhone 捷徑把金額、商家、卡片送到你自己的伺服器（不經過其他公司）</div></li>
          <li><span>✅</span><div><b>打開 App 確認</b><br />自動判斷分類與帳戶，一鍵記帳；確定都正確後也可以改成自動入帳</div></li>
        </ol>
        <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
          🔒 Clure 不會讀取你的簡訊、銀行或 Apple 錢包；只有你自己設定的捷徑會送資料進來，而且捷徑用的「權杖」只能寄信、不能看帳。
          收件匣的內容處理完就刪除，30 天沒處理也會自動清除。
        </p>
      </details>

      <div className="section-title">待確認{entries?.length ? `（${entries.length}）` : ''}</div>
      {error && <div className="card"><p style={{ margin: 0 }}>無法取得收件匣：{error}</p></div>}
      {entries === null ? <SkeletonRows n={2} /> : entries.length === 0 ? (
        <EmptyState emoji="📭" title="收件匣是空的" text={tokens?.length ? '用 Apple Pay 付款或對 Siri 說一句話，這裡就會出現待記帳的項目。' : '先在下方設定捷徑，之後付款就會自動出現在這裡。'} />
      ) : (
        <>
          <div className="list">
            {entries.map((e) => {
              const src = SOURCE_LABEL[e.item.source] ?? SOURCE_LABEL.other;
              if (!e.drafts.length) {
                return (
                  <div key={e.item.id} className="row inbox-row">
                    <span className="cat-icon sm" aria-hidden="true">{src.icon}</span>
                    <span className="row-main">
                      <span className="row-title">{e.item.merchant || e.item.text.slice(0, 40) || '（沒有內容）'}</span>
                      <span className="row-sub">{src.label} · 看不懂金額，請手動記</span>
                    </span>
                    <span className="inbox-actions">
                      <button className="pill" onClick={() => edit(e)}>手動記</button>
                      <button className="pill" onClick={() => void skip(e)} aria-label="略過">略過</button>
                    </span>
                  </div>
                );
              }
              return e.drafts.map((d, i) => {
                const c = d.categoryId ? catMap.get(d.categoryId) : undefined;
                const acc = accMap.get(d.accountId);
                const cur = d.currency ?? acc?.currency ?? 'TWD';
                return (
                  <div key={`${e.item.id}-${i}`} className="row inbox-row">
                    <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true">{d.kind === 'transfer' ? '🔁' : c?.icon ?? src.icon}</span>
                    <span className="row-main">
                      <span className="row-title">{d.note || c?.name || src.label}</span>
                      <span className="row-sub">{src.icon} {shortDate(d.date, today)} · {c?.name ?? '轉帳'} · {acc?.name ?? '?'}{e.item.card ? `（${e.item.card}）` : ''}</span>
                    </span>
                    <span className={`num ${d.kind === 'income' ? 'pos' : 'neg'}`}>{formatMoney(toMinor(d.amount, cur), cur)}</span>
                    {i === e.drafts.length - 1 && (
                      <span className="inbox-actions">
                        <button className="pill accent-pill" disabled={busy} onClick={() => void book([e])}>記帳</button>
                        <button className="pill" onClick={() => edit(e)}>編輯</button>
                        <button className="pill" onClick={() => void skip(e)}>略過</button>
                      </span>
                    )}
                  </div>
                );
              });
            })}
          </div>
          {ready.length > 1 && <button className="btn" disabled={busy} onClick={() => void book(ready)}>全部記帳（{ready.reduce((n, e) => n + e.drafts.length, 0)} 筆）</button>}
        </>
      )}

      <div className="section-title">設定 iPhone 捷徑</div>
      <div className="list">
        {tokens?.map((t) => (
          <div key={t.id} className="row">
            <span className="row-main">
              <span className="row-title">{t.name} <span className="faint num">••••{t.hint}</span></span>
              <span className="row-sub">{t.last_used_at ? `上次送出：${new Date(`${t.last_used_at}Z`).toLocaleString('zh-TW')}` : '還沒有送過資料'}</span>
            </span>
            <button className="pill" style={{ color: 'var(--danger)' }} onClick={async () => {
              if (!window.confirm(`撤銷「${t.name}」？使用這組權杖的捷徑將無法再送出。`)) return;
              try { await revokeToken(t.id); setTokens((l) => l?.filter((x) => x.id !== t.id) ?? null); } catch (e) { snack((e as Error).message); }
            }}>撤銷</button>
          </div>
        ))}
        <button className="row accent" onClick={() => void newToken()}><Icon name="plus" /> 建立捷徑權杖</button>
      </div>

      {fresh && (
        <div className="card inbox-token">
          <p style={{ marginTop: 0 }}><b>「{fresh.name}」的權杖已建立</b> — 只會顯示這一次，請現在複製到捷徑裡。</p>
          <div className="copy-row"><span className="label">網址</span><code>{hookUrl()}</code><button className="pill" onClick={() => void copy(hookUrl(), '網址')}>複製</button></div>
          <div className="copy-row"><span className="label">標頭值</span><code>Bearer {fresh.token}</code><button className="pill" onClick={() => void copy(`Bearer ${fresh.token}`, '標頭值')}>複製</button></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn tinted small" onClick={() => void sendTest()}>傳送測試項目</button>
            <button className="btn secondary small" onClick={() => setFresh(null)}>我已複製好了</button>
          </div>
        </div>
      )}

      <ShortcutGuides />

      <div className="section-title">記帳方式</div>
      <div className="list">
        <SwitchField label="看得懂的直接記帳" sub="開啟 App 時自動記下有金額的項目，不用一筆筆確認。Apple Pay 偶爾會送來空白或被拒絕的交易，建議先手動確認一陣子再開啟"
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
                  {accounts.filter((a) => a.type !== 'loan').map((a) => <option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
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
        <p className="muted">完成後用 Apple Pay 付一筆，打開 Clure 就會在收件匣看到。</p>
      </details>
      <details className="card">
        <summary><b>💬 銀行刷卡簡訊自動記帳</b></summary>
        <ol>
          <li>「自動化」→「＋」→ 選「<b>訊息</b>」。</li>
          <li>「寄件者」選銀行的簡訊號碼，或「訊息包含」填「<b>消費</b>」；選「立即執行」。</li>
          {common}
        </ol>
        <table className="inbox-fields"><tbody>
          <tr><td><code>source</code></td><td>sms</td></tr>
          <tr><td><code>text</code></td><td>「捷徑輸入」→「<b>內容</b>」（整則簡訊）</td></tr>
        </tbody></table>
        <p className="muted">Clure 會從簡訊找出「NT$」後面的金額、「商店」後面的店名，以及卡片對應的帳戶。很多銀行已改成 App 推播，iPhone 無法自動讀取推播。</p>
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
