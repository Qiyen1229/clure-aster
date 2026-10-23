/**
 * 記帳專用數字鍵盤：支援 + − × ÷，含 00、退格（長按清除）、完成／=。
 * 也支援實體鍵盤輸入（桌機）。
 */
import { useEffect, useRef } from 'react';
import { Icon } from '@/ui/Icon';

interface Props {
  onKey: (k: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  disabled?: boolean;
}

const ROWS: string[][] = [
  ['7', '8', '9', '÷', '⌫'],
  ['4', '5', '6', '×', 'C'],
  ['1', '2', '3', '−', 'SAVE'],
  ['00', '0', '.', '+'],
];

export function Keypad({ onKey, onSubmit, submitLabel, disabled }: Props) {
  const longTimer = useRef<number>();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      const map: Record<string, string> = { '*': '×', '/': '÷', '-': '−', Backspace: '⌫', Escape: '', Delete: 'C' };
      if (/^[0-9.+]$/.test(e.key)) onKey(e.key);
      else if (map[e.key]) onKey(map[e.key]);
      else if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); onSubmit(); return; }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKey, onSubmit]);

  return (
    <div className="keypad" role="group" aria-label="數字鍵盤">
      {ROWS.flat().map((k) => {
        if (k === 'SAVE') {
          return (
            <button key={k} className="key save" onClick={onSubmit} disabled={disabled}>{submitLabel}</button>
          );
        }
        const isOp = ['÷', '×', '−', '+'].includes(k);
        const label = k === '⌫' ? <Icon name="backspace" /> : k;
        return (
          <button key={k} className={`key num${isOp ? ' op' : ''}${k === 'C' || k === '⌫' ? ' fn' : ''}`}
            aria-label={k === '⌫' ? '退格（長按清除）' : k === 'C' ? '清除' : k}
            onClick={() => onKey(k)}
            onPointerDown={() => {
              if (k !== '⌫') return;
              longTimer.current = window.setTimeout(() => { onKey('C'); navigator.vibrate?.(15); }, 550);
            }}
            onPointerUp={() => clearTimeout(longTimer.current)}
            onPointerLeave={() => clearTimeout(longTimer.current)}>
            {label}
          </button>
        );
      })}
    </div>
  );
}
