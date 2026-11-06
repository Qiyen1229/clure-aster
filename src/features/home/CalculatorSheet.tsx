/**
 * 計算機（首頁右上角，搜尋左邊）：四則運算＋記帳常用的快捷（服務費 ＋10%、稅 ＋5%、打折、AA 平分、取整、外幣換算），
 * 按「＝」算出的結果會記下來（預設最近 10 筆，可改 5／10／20／50，存在這個帳號的本機資料庫）。
 * 每筆結果都能一鍵複製，或一鍵「記一筆」——只帶金額進記帳面板，帳戶、分類、日期都用預設值。
 */
import Decimal from 'decimal.js';
import { useCallback, useMemo, useState } from 'react';
import { evaluate, hasOperator, pressKey } from '@/domain/calc-expr';
import { addThousands, CURRENCIES } from '@/domain/money';
import { getRate } from '@/services/fx';
import { clearCalc, KEEP_CHOICES, pushCalc, setCalcKeep, useCalcHistory } from '@/services/calcHistory';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { Keypad } from '../add/Keypad';

const QUICK: { label: string; hint?: string; fn: (v: Decimal) => Decimal }[] = [
  { label: '＋10%', hint: '服務費', fn: (v) => v.mul(1.1) },
  { label: '＋5%', hint: '稅', fn: (v) => v.mul(1.05) },
  { label: '9 折', fn: (v) => v.mul(0.9) },
  { label: '85 折', fn: (v) => v.mul(0.85) },
  { label: '8 折', fn: (v) => v.mul(0.8) },
  { label: '7 折', fn: (v) => v.mul(0.7) },
  { label: 'AA 2 人', fn: (v) => v.div(2) },
  { label: 'AA 3 人', fn: (v) => v.div(3) },
  { label: 'AA 4 人', fn: (v) => v.div(4) },
  { label: 'AA 5 人', fn: (v) => v.div(5) },
  { label: 'AA 6 人', fn: (v) => v.div(6) },
  { label: '取整', fn: (v) => v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP) },
];

const MAX_DECIMALS = 4;
const snack = (text: string) => useUI.getState().showSnack({ text });

/** 一鍵複製（純數字，不帶千分位，貼到別處可以直接用） */
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); snack(`已複製 ${text}`); return; } catch { /* 改用備援 */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); snack(`已複製 ${text}`); } catch { snack('複製失敗，請長按數字手動複製'); }
  ta.remove();
}

const show = (s: string) => {
  const [i, f] = s.split('.');
  return addThousands(i) + (f !== undefined ? `.${f}` : '');
};
const plain = (v: Decimal) => v.toDecimalPlaces(MAX_DECIMALS).toString();

export function CalculatorSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const base = useSettings((s) => s.baseCurrency);
  const [expr, setExpr] = useState('');
  const [fxOpen, setFxOpen] = useState(false);
  const { list, keep } = useCalcHistory();
  const value = useMemo(() => evaluate(expr), [expr]);
  const onKey = useCallback((k: string) => setExpr((e) => pressKey(e, k, MAX_DECIMALS)), []);

  const equals = () => {
    if (!hasOperator(expr)) return;
    if (!value) { snack('運算式有誤'); return; }
    const r = plain(value);
    void pushCalc(expr, r);
    setExpr(r);
  };
  /** 對目前的數字做一個快捷運算，並記下「算式 → 結果」 */
  const quick = (label: string, fn: (v: Decimal) => Decimal) => {
    if (!value) { snack('先輸入一個數字'); return; }
    const r = plain(fn(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
    void pushCalc(`${show(plain(value))} ${label}`, r);
    setExpr(r);
  };
  const convert = async (code: string) => {
    if (!value) { snack('先輸入外幣金額'); return; }
    const rate = await getRate(code, base).catch(() => null);
    if (!rate) { snack(`取不到 ${code}→${base} 的匯率，請先到「設定 → 幣別與匯率」更新`); return; }
    const r = plain(value.mul(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
    void pushCalc(`${show(plain(value))} ${code} → ${base}（匯率 ${rate.toDecimalPlaces(4).toString()}）`, r);
    setExpr(r);
    setFxOpen(false);
  };
  /** 一鍵轉到記一筆：只帶金額，帳戶、分類、日期都用記帳面板的預設 */
  const toAdd = (amount: string, expression?: string) => {
    const n = new Decimal(amount);
    if (!n.gt(0)) { snack('金額需大於 0 才能記一筆'); return; }
    if (expression) void pushCalc(expression, amount);
    onClose();
    useUI.getState().openAdd({ mode: 'expense', amount: n.toDecimalPlaces(2).toString() });
  };

  const resultText = value ? plain(value) : '';
  const display = !expr ? '0' : hasOperator(expr) ? (value ? show(value.toDecimalPlaces(MAX_DECIMALS).toFixed()) : '—') : show(expr);

  return (
    <Sheet open={open} onClose={onClose} title="計算機" variant="rise">
      <section className="calc-display" aria-live="polite">
        <div className="calc-expr num" aria-hidden="true">{hasOperator(expr) ? expr : ''}</div>
        <div className="calc-value num">{display}</div>
        <div className="calc-actions">
          <button className="btn small tinted" disabled={!resultText} onClick={() => void copyText(resultText)}><Icon name="copy" size={16} />複製</button>
          <button className="btn small" disabled={!resultText} onClick={() => toAdd(resultText, hasOperator(expr) ? `${expr}` : undefined)}><Icon name="plus" size={16} />記一筆</button>
        </div>
      </section>

      <div className="calc-quick" role="group" aria-label="記帳快捷">
        {QUICK.map((q) => (
          <button key={q.label} className="pill" onClick={() => quick(q.label, q.fn)}>{q.label}{q.hint ? <span className="calc-hint">{q.hint}</span> : null}</button>
        ))}
        <button className="pill" aria-pressed={fxOpen} onClick={() => setFxOpen((x) => !x)}>外幣→{base} ▾</button>
      </div>
      {fxOpen && (
        <div className="calc-quick" role="group" aria-label="選擇外幣">
          {Object.values(CURRENCIES).filter((c) => c.code !== base).slice(0, 12).map((c) => (
            <button key={c.code} className="pill" onClick={() => void convert(c.code)}>{c.code}</button>
          ))}
        </div>
      )}

      <Keypad onKey={onKey} onSubmit={equals} submitLabel="＝" />

      <div className="calc-history-head">
        <b>記錄（最近 {keep} 筆）</b>
        <span className="calc-history-tools">
          <select aria-label="保存筆數" value={keep} onChange={(e) => void setCalcKeep(Number(e.target.value))}>
            {KEEP_CHOICES.map((n) => <option key={n} value={n}>保存 {n} 筆</option>)}
          </select>
          {list.length > 0 && <button className="accent" onClick={() => void clearCalc()}>清除</button>}
        </span>
      </div>
      {list.length === 0 ? <p className="muted" style={{ margin: '4px 4px 16px' }}>按「＝」或用快捷運算後，結果會記在這裡。</p> : (
        <div className="list" style={{ marginBottom: 12 }}>
          {list.map((h) => (
            <div key={h.id} className="row calc-row">
              <button className="row-main calc-row-main" onClick={() => setExpr(h.result)} aria-label={`帶回計算機：${h.result}`}>
                <span className="row-sub calc-row-expr">{h.expr}</span>
                <span className="row-title num">= {show(h.result)}</span>
              </button>
              <button className="icon-btn plain" aria-label={`複製 ${h.result}`} onClick={() => void copyText(h.result)}><Icon name="copy" size={18} /></button>
              <button className="icon-btn plain" aria-label={`把 ${h.result} 記一筆`} onClick={() => toAdd(h.result)}><Icon name="plus" size={18} /></button>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
