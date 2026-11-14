/**
 * 自動記帳白名單：這些發送者的通知直接入帳、不用手動確認（即使沒開全域「看得懂的直接記帳」）。
 * 入口：收件匣右上角盾牌圖示、iPhone 捷徑頁的「自動入帳偏好」。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { EmptyState } from '@/ui/controls';
import { Icon } from '@/ui/Icon';

const snack = (text: string) => useUI.getState().showSnack({ text });

export default function InboxWhitelistPage() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.inbox);
  const set = useSettings((s) => s.set);
  const list = cfg.whitelist ?? [];
  const [name, setName] = useState('');

  const add = () => {
    const n = name.trim().slice(0, 40);
    if (!n) return;
    if (list.some((x) => x.toLowerCase() === n.toLowerCase())) { snack('這個發送者已經在白名單裡了'); return; }
    set('inbox', { ...cfg, whitelist: [...list, n] });
    setName('');
    snack(`已加入「${n}」：之後它的通知會直接記帳`);
  };
  const remove = (n: string) => set('inbox', { ...cfg, whitelist: list.filter((x) => x !== n) });

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>自動記帳白名單</h1>
        <div style={{ width: 36 }} />
      </header>

      <div className="card">
        <p style={{ margin: 0 }}>白名單裡的發送者，通知會<b>直接記帳、不用手動確認</b>——即使沒有開啟「看得懂的直接記帳」。</p>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.8rem' }}>比對方式：名稱出現在通知內容或商家裡就算命中（不分大小寫）。例如加入「某某銀行」，內容含有「某某銀行」的通知都會直接入帳。請只加入你信任的發送者；看不懂金額或疑似重複的項目仍會留在收件匣。</p>
      </div>

      <div className="section-title">新增發送者</div>
      <div className="list">
        <div className="field">
          <input value={name} maxLength={40} placeholder="發送者名稱，例如 LINE 帳號或銀行名稱" aria-label="發送者名稱" style={{ flex: 1 }}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <button className="pill accent-pill" disabled={!name.trim()} onClick={add}>加入</button>
        </div>
      </div>

      <div className="section-title">白名單（{list.length}）</div>
      {list.length === 0 ? (
        <EmptyState emoji="🛡️" title="白名單是空的" text="目前所有通知都要手動確認，或照「看得懂的直接記帳」設定處理。" />
      ) : (
        <div className="list">
          {list.map((n) => (
            <div key={n} className="row">
              <span className="row-main">
                <span className="row-title">{n}</span>
                <span className="row-sub">含有這個名稱的通知會直接記帳</span>
              </span>
              <button className="pill" onClick={() => remove(n)}>移除</button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}