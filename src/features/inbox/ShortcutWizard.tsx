/**
 * iPhone 捷徑安裝精靈：六個做好、簽署過的捷徑，一個一個「加入」，從「捷徑」App 回來就自動打勾，接著提示下一個。
 * iPhone 不允許 App 代為建立「自動化」，所以 Apple Pay／簡訊兩個捷徑加入後，精靈會用勾選清單帶你做完那一步。
 * 勾選狀態只存在這台裝置（localStorage，依使用者區分），不會上傳；它只是「你做到哪了」的備忘，不是偵測。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SHORTCUTS } from '@/services/inbox';
import { useAuth } from '@/stores/auth';

type Def = (typeof SHORTCUTS)[number];
type Done = { added: string[]; auto: string[] };

const key = () => `clure.inbox.wizard.${useAuth.getState().user?.id ?? 0}`;
const PENDING = 'clure.inbox.wizard.pending';

function load(): Done {
  try {
    const v = JSON.parse(localStorage.getItem(key()) ?? 'null') as Done | null;
    return { added: Array.isArray(v?.added) ? v!.added : [], auto: Array.isArray(v?.auto) ? v!.auto : [] };
  } catch { return { added: [], auto: [] }; }
}
function save(d: Done) { try { localStorage.setItem(key(), JSON.stringify(d)); } catch { /* 私密瀏覽 */ } }

export function ShortcutWizard({ preparing, onAdd, hasLink }: { preparing: boolean; onAdd: (s: Def) => Promise<void>; hasLink: boolean }) {
  const [done, setDone] = useState<Done>(load);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const mark = useCallback((k: string, what: keyof Done, on: boolean) => {
    setDone((d) => {
      const next = { ...d, [what]: on ? [...new Set([...d[what], k])] : d[what].filter((x) => x !== k) };
      save(next);
      return next;
    });
  }, []);

  // 從「捷徑」App 回到 Aster：剛才按了「加入」的那個捷徑自動打勾（匯入被取消也會打勾，這只是備忘，可以點勾勾取消）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      let k: string | null = null;
      try { k = sessionStorage.getItem(PENDING); sessionStorage.removeItem(PENDING); } catch { /* 忽略 */ }
      if (k) { mark(k, 'added', true); setJustAdded(k); }
    };
    document.addEventListener('visibilitychange', onVisible);
    onVisible(); // 同一個分頁被系統丟掉重載時，回來的當下也補做一次
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [mark]);

  const add = async (s: Def) => {
    try { sessionStorage.setItem(PENDING, s.key); } catch { /* 忽略 */ }
    await onAdd(s);
  };

  const left = SHORTCUTS.filter((s) => !done.added.includes(s.key));
  const next = left[0];
  const pct = Math.round(((SHORTCUTS.length - left.length) / SHORTCUTS.length) * 100);
  const needAuto = SHORTCUTS.filter((s) => s.automation && done.added.includes(s.key) && !done.auto.includes(s.key));

  return (
    <div className="card inbox-oneclick" ref={listRef}>
      <div className="wiz-head">
        <b>已加入 {SHORTCUTS.length - left.length}／{SHORTCUTS.length}</b>
        <div className="wiz-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
      </div>
      {justAdded && next && (
        <p className="wiz-next" role="status">✅ 「{SHORTCUTS.find((s) => s.key === justAdded)?.name}」已標記為加入。下一個：<b>{next.title}</b></p>
      )}
      <ol className="oneclick-steps">
        <li>按「<b>加入</b>」：自動複製你的<b>連結碼</b>並切換到「捷徑」App，跳出「加入捷徑」</li>
        <li>按「<b>設定捷徑</b>」，長按輸入框 →「<b>貼上</b>」，再按「<b>加入捷徑</b>」</li>
        <li>回到 Aster（左上角「◀ Aster」），這裡會自動打勾，接著加下一個</li>
      </ol>
      {next && (
        <button className="btn" style={{ margin: '4px 0 10px' }} disabled={preparing} onClick={() => void add(next)}>
          {preparing ? '準備中…' : `依序加入：${next.title}`}
        </button>
      )}
      {SHORTCUTS.map((s) => {
        const added = done.added.includes(s.key);
        return (
          <div key={s.key} className={`oneclick-item${added ? ' is-done' : ''}`}>
            <div className="oneclick-row">
              <button className={`wiz-check${added ? ' on' : ''}`} aria-pressed={added} aria-label={`${s.title}：${added ? '已加入（點一下取消標記）' : '尚未加入'}`}
                onClick={() => mark(s.key, 'added', !added)}>{added ? '✓' : ''}</button>
              <span className="row-main">
                <span className="row-title">{s.title}</span>
                <span className="row-sub" style={{ whiteSpace: 'normal' }}>{s.hint}</span>
              </span>
              <button className={`pill${added ? '' : ' accent-pill'}`} disabled={preparing} onClick={() => void add(s)}>{added ? '重新加入' : '加入'}</button>
            </div>
            {s.key === 'quick' && added && <p className="muted oneclick-note">設定 → 動作按鈕（或「輔助使用 → 觸控 → 背面輕點」）選「捷徑」→「<b>{s.name}</b>」，之後一按就跳出輸入框。</p>}
            {s.key === 'share' && added && <p className="muted oneclick-note">在任何 App 按分享 → 往下找「<b>{s.name}</b>」（第一次要到「編輯動作」把它加進常用）。</p>}
          </div>
        );
      })}
      {needAuto.length > 0 && (
        <div className="wiz-auto" role="group" aria-label="還差一步：建立自動化">
          <b>還差一步：建立自動化</b>
          {needAuto.map((s) => (
            <div key={s.key} className="wiz-auto-item">
              <p className="wiz-auto-title"><b>{s.title}</b></p>
              <ol className="wiz-auto-steps">
                <li>打開「捷徑」App → 「自動化」，再點最下方的「＋」</li>
                {s.key === 'applepay' ? (
                  <li>點「自動化操作」標籤，找到「錢包」點它，再進入搜尋框，搜尋「執行捷徑」點它，「捷徑」選「{s.name}」</li>
                ) : (
                  <>
                    <li>點上方「自動化操作」標籤找到「訊息」（說明是「當我收到傳來的訊息時」）</li>
                    <li>這個觸發一定要填條件才能啟用：「寄件人 是」點藍字選你的銀行（簡訊的號碼或聯絡人）；再點「加入過濾條件」，訊息可依銀行曾寄送的訊息自行填寫，避免把驗證碼簡訊也記進來</li>
                    <li>再點搜尋框，搜尋「執行捷徑」，「捷徑」選「{s.name}」</li>
                  </>
                )}
              </ol>
              <button className="pill accent-pill" onClick={() => mark(s.key, 'auto', true)}>我做好了 ✓</button>
            </div>
          ))}
        </div>
      )}
      {!hasLink && <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.8rem' }}>第一次按「加入」時，會自動建立專用的連結碼（只能寄資料進來、不能讀帳）。</p>}
    </div>
  );
}
