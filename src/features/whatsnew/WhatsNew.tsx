/**
 * 更新後的新功能說明視窗：更新後第一次開啟 App，主動跳出「從你上次用的版本到現在新增了什麼」。
 * 範圍是「上次看過的版本 → 目前版本」中間所有版本的功能（不是只有最新一版）。
 * 每一項最上面是功能標題與「哪一版更新的」，下面是一段介紹與如何使用。看完按「知道了」就記下目前版本，下次更新才會再跳出。
 * 全新安裝（還沒做完首次引導）不跳；更新沒有新功能（只有小修正）就靜默記下版本。
 */
import { useEffect, useState } from 'react';
import { useSettings } from '@/stores/settings';
import { Sheet } from '@/ui/Sheet';
import { featuresBetween, type WhatsNewItem } from './releaseNotes';

const KEY = 'aster.seenVersion';
/** 這個機制上線前的最後一版：已經在用、但還沒有紀錄的使用者，視為從這一版更新上來 */
export const LEGACY_BASELINE = '4.1.13';

/** 決定要不要跳出視窗，並記下目前版本（純邏輯，方便測試）。storage 讀寫失敗就當作沒有紀錄 */
export function planWhatsNew(opts: { current: string; onboarded: boolean; read: () => string | null; write: (v: string) => void }): { seen: string; items: WhatsNewItem[] } | null {
  const { current, onboarded, read, write } = opts;
  if (!onboarded) { write(current); return null; } // 全新安裝：引導裡已經介紹過，不跳
  const seen = read() ?? LEGACY_BASELINE;
  if (seen === current) return null;
  const items = featuresBetween(seen, current);
  if (!items.length) { write(current); return null; } // 只有小修正：靜默記下
  return { seen, items };
}

export function WhatsNewHost() {
  const onboarded = useSettings((s) => s.onboarded);
  const [state, setState] = useState<{ seen: string; items: WhatsNewItem[] } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!onboarded) return;
    const plan = planWhatsNew({
      current: __APP_VERSION__, onboarded,
      read: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
      write: (v) => { try { localStorage.setItem(KEY, v); } catch { /* 忽略 */ } },
    });
    if (plan) { setState(plan); const t = setTimeout(() => setOpen(true), 900); return () => clearTimeout(t); } // 等主畫面出來再跳，不搶開啟的瞬間
  }, [onboarded]);

  const close = () => {
    setOpen(false);
    try { localStorage.setItem(KEY, __APP_VERSION__); } catch { /* 忽略 */ }
  };
  if (!state) return null;
  const n = state.items.length;
  return (
    <Sheet open={open} onClose={close} title="新功能">
      <div className="whatsnew">
        <p className="whatsnew-lead">
          {state.seen === __APP_VERSION__ ? '' : <>你從 <b>v{state.seen}</b> 更新到 <b>v{__APP_VERSION__}</b>，這中間共新增 <b>{n}</b> 項功能。</>}
        </p>
        {state.items.map((f) => (
          <article key={`${f.version}-${f.title}`} className="whatsnew-card">
            <header>
              <h3>{f.title}</h3>
              <span className="whatsnew-ver" title={`${f.date} 更新`}>v{f.version}</span>
            </header>
            <p>{f.intro}</p>
            <p className="whatsnew-how"><b>如何使用</b>{f.howto}</p>
          </article>
        ))}
        <button className="btn" style={{ marginTop: 8 }} onClick={close}>知道了</button>
      </div>
    </Sheet>
  );
}
