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
            {s.key === 'voice' && added && (
              <p className="muted oneclick-note">
                對 Siri 說「<b>{s.name}</b>，午餐 120」即可語音記帳；也可以在任何 App 選取文字或帳單點分享 ➔ 選擇「<b>{s.name}</b>」。
              </p>
            )}
          </div>
        );
      })}
      {needAuto.length > 0 && (
        <div className="wiz-auto" role="group" aria-label="還差一步：建立自動化">
          <b>還差一步：啟用自動化</b>
          {needAuto.map((s) => (
            <div key={s.key} className="wiz-auto-item">
              <p className="wiz-auto-title"><b>{s.title}</b></p>
              <ol className="wiz-auto-steps" style={{ paddingLeft: '1.2rem' }}>
                <li style={{ listStyle: 'none', margin: '2px 0 4px -1.2rem', fontWeight: 600, color: 'var(--accent)' }}>
                  💡 推薦方式（已內建 36 家銀行、支付 App 與 Apple Pay 自動化，免手動勾選）：
                </li>
                <li>打開「捷徑」App，找到剛加入的「<b>{s.name}</b>」，點右上角「<b>⋯</b>」進入編輯。</li>
                <li>點最上方虛線框的「<b>已關閉自動化</b>」（或時鐘圖示）。</li>
                <li>切換為「<b>立即執行</b>」，並關閉「執行時通知」即可！若有想增減的 App 可點虛線框內的 ＋ 調整。</li>
                <li style={{ listStyle: 'none', margin: '8px 0 4px -1.2rem', fontWeight: 600, color: 'var(--muted)' }}>
                  備用方式（若捷徑上方無虛線框，手動建立步驟）：
                </li>
                <li>打開「捷徑」App ➔ 下方「自動化」➔ 點「＋」➔ 點上方「自動化操作」找到「<b>App 通知</b>」（或「錢包」交易）。</li>
                <li>「App」勾選常用的銀行、LINE Pay、街口等 ➔ 勾選「<b>立即執行</b>」➔ 下一步搜尋「執行捷徑」選「<b>{s.name}</b>」。</li>
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
