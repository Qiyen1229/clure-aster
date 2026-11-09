/**
 * 更新後的新功能說明視窗：更新後第一次開啟 App，主動跳出「從你上次用的版本到現在新增了什麼」。
 * 範圍是「上次看過的版本 → 目前版本」中間所有版本的功能（不是只有最新一版）。
 * 每一項最上面是功能標題與「哪一版更新的」，下面是一段介紹與如何使用。看完按「知道了」就記下目前版本，下次更新才會再跳出。
 * 全新安裝（還沒做完首次引導）不跳；更新沒有新功能（只有小修正）就靜默記下版本。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings } from '@/stores/settings';
import { haptic } from '@/services/haptics';
import { Icon } from '@/ui/Icon';
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
  const [page, setPage] = useState(0);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!onboarded) return;
    const plan = planWhatsNew({
      current: __APP_VERSION__, onboarded,
      read: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
      write: (v) => { try { localStorage.setItem(KEY, v); } catch { /* 忽略 */ } },
    });
    if (plan) {
      setState(plan);
      setPage(0);
      const t = setTimeout(() => setOpen(true), 900);
      return () => clearTimeout(t);
    } // 等主畫面出來再跳，不搶開啟的瞬間
  }, [onboarded]);

  // 開啟前保留原本焦點，關閉時歸還；同時鎖定 body 捲動，防止背景內容被滑動
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    prevFocus.current = document.activeElement as HTMLElement | null;

    return () => {
      document.body.style.overflow = prevOverflow;
      const el = prevFocus.current;
      prevFocus.current = null;
      setTimeout(() => el?.isConnected && el.focus?.({ preventScroll: true }), 0);
    };
  }, [open]);

  // 阻擋觸控事件穿透至背景：點擊在遮罩上時阻止捲動穿透，彈窗內保持 1:1 跟手原生捲動
  useEffect(() => {
    const el = wrapRef.current;
    if (!open || !el) return;
    const onTouchMove = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.whatsnew-modal')) return;
      e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, [open]);

  const n = state?.items.length ?? 0;
  const isLast = page >= n - 1;

  const goToPage = useCallback((idx: number) => {
    const target = Math.max(0, Math.min(n - 1, idx));
    haptic('selection');
    setPage(target);
    const el = sliderRef.current;
    if (el) {
      el.scrollTo({ left: target * el.clientWidth, behavior: 'smooth' });
    }
  }, [n]);

  const onScroll = () => {
    const el = sliderRef.current;
    if (!el || el.clientWidth === 0) return;
    const p = Math.round(el.scrollLeft / el.clientWidth);
    if (p !== page && p >= 0 && p < n) {
      haptic('selection');
      setPage(p);
    }
  };

  // 鍵盤左右箭頭換頁
  useEffect(() => {
    if (!open || n <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        goToPage(page + 1);
      } else if (e.key === 'ArrowLeft') {
        goToPage(page - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, n, page, goToPage]);

  const close = () => {
    setOpen(false);
    try { localStorage.setItem(KEY, __APP_VERSION__); } catch { /* 忽略 */ }
  };

  if (!state || !open || n === 0) return null;

  return (
    <div
      ref={wrapRef}
      className="whatsnew-wrap"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whatsnew-modal-title"
    >
      <div className="whatsnew-backdrop" aria-hidden="true" onClick={close} />
      <div className="whatsnew-modal">
        <header className="whatsnew-header">
          <h2 id="whatsnew-modal-title" className="whatsnew-title">新功能介紹</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="whatsnew-count">{page + 1} / {n}</span>
            <button type="button" className="icon-btn plain" aria-label="關閉" onClick={close} style={{ width: 32, height: 32, minHeight: 32 }}>
              <Icon name="x" size={18} />
            </button>
          </div>
        </header>

        <div
          ref={sliderRef}
          className="whatsnew-slider"
          onScroll={onScroll}
        >
          <div className="whatsnew-slides">
            {state.items.map((f, i) => (
              <article key={`${f.version}-${f.title}-${i}`} className="whatsnew-slide">
                <div className="whatsnew-card">
                  <header>
                    <h3>{f.title}</h3>
                    <span className="whatsnew-ver" title={`${f.date} 更新`}>v{f.version}</span>
                  </header>
                  <p className="whatsnew-intro">{f.intro}</p>
                  <div className="whatsnew-how">
                    <b>如何使用</b>
                    <span>{f.howto}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>

        {n > 1 && (
          <div className="whatsnew-dots" role="tablist" aria-label="切換功能">
            {state.items.map((f, i) => (
              <button
                key={`${f.title}-${i}`}
                role="tab"
                aria-selected={i === page}
                aria-label={`${i + 1} / ${n}：${f.title}`}
                className={i === page ? 'on' : ''}
                onClick={() => goToPage(i)}
              />
            ))}
          </div>
        )}

        <div className="whatsnew-actions">
          {page > 0 && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => goToPage(page - 1)}
            >
              上一頁
            </button>
          )}
          {isLast ? (
            <button
              type="button"
              className="btn"
              onClick={close}
            >
              知道了
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => goToPage(page + 1)}
            >
              下一頁
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
