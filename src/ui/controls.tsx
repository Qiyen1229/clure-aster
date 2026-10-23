/**
 * 基本控制元件：分段控制、開關、金額文字（含隱藏金額、數字滾動）、空狀態、骨架屏。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoney, type FormatOptions } from '@/domain/money';
import { useSettings } from '@/stores/settings';

export function Segmented<T extends string | number>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      <span className="seg-thumb" style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${idx * 100}%)`, left: 2 }} />
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

/** 使用目前設定（小數位、千分位、隱藏金額）格式化 */
export function useMoneyFormat() {
  const { decimals, thousands, hideAmounts } = useSettings();
  return (minor: number, currency: string, opts: FormatOptions = {}) =>
    hideAmounts ? '••••' : formatMoney(minor, currency, { decimals, thousands, ...opts });
}

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 數字滾動動畫（整數插值，最終值保證精確） */
function useAnimatedInt(target: number, duration = 600): number {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reduceMotion() || from.current === target) { setV(target); from.current = target; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(p === 1 ? target : Math.round(a + (target - a) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = target; };
  }, [target, duration]);
  return v;
}

export function Amount({ minor, currency, tone, animate, opts, className = '' }: {
  minor: number;
  currency: string;
  /** auto：正數 pos、負數 neg；none：不上色 */
  tone?: 'auto' | 'pos' | 'neg' | 'none';
  animate?: boolean;
  opts?: FormatOptions;
  className?: string;
}) {
  const fmt = useMoneyFormat();
  const shown = useAnimatedInt(minor, animate ? 600 : 0);
  const value = animate ? shown : minor;
  const t = tone === 'auto' ? (minor > 0 ? 'pos' : minor < 0 ? 'neg' : '') : tone === 'none' || !tone ? '' : tone;
  return <span className={`amount ${t} ${className}`}>{fmt(value, currency, opts)}</span>;
}

export function EmptyState({ emoji, title, text, action }: { emoji: string; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <div className="em" aria-hidden="true">{emoji}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function SkeletonRows({ n = 4 }: { n?: number }) {
  return (
    <div aria-busy="true" aria-label="載入中">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="row" style={{ borderRadius: 16, marginBottom: 8 }}>
          <div className="skeleton" style={{ width: 40, height: 40, borderRadius: 20 }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ width: '50%', height: 14, marginBottom: 6 }} />
            <div className="skeleton" style={{ width: '30%', height: 11 }} />
          </div>
          <div className="skeleton" style={{ width: 64, height: 16 }} />
        </div>
      ))}
    </div>
  );
}
