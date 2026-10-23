/**
 * 記帳鍵盤的四則運算（不使用 eval）。支援 + − × ÷（以及 + - * /）、小數點、
 * 開頭負號、先乘除後加減。全部以 decimal.js 計算，避免 0.1 + 0.2 問題。
 */
import Decimal from 'decimal.js';

type Tok = { t: 'num'; v: Decimal } | { t: 'op'; v: '+' | '-' | '*' | '/' };

const OP_MAP: Record<string, '+' | '-' | '*' | '/'> = {
  '+': '+', '-': '-', '−': '-', '*': '*', '×': '*', '/': '/', '÷': '/',
};

export function isOperator(ch: string): boolean {
  return ch in OP_MAP;
}

export function hasOperator(expr: string): boolean {
  // 開頭的負號不算運算
  return /[+\-−*×/÷]/.test(expr.slice(1));
}

function tokenize(expr: string): Tok[] | null {
  const out: Tok[] = [];
  let num = '';
  const flush = () => {
    if (num === '') return true;
    if (num === '.' || (num.match(/\./g)?.length ?? 0) > 1) return false;
    out.push({ t: 'num', v: new Decimal(num.startsWith('.') ? '0' + num : num) });
    num = '';
    return true;
  };
  for (const ch of expr.replace(/[\s,]/g, '')) {
    if (/[0-9.]/.test(ch)) {
      num += ch;
    } else if (isOperator(ch)) {
      if (!flush()) return null;
      const op = OP_MAP[ch];
      const prev = out[out.length - 1];
      // 一元負號：開頭或緊接在運算子之後
      if (op === '-' && (!prev || prev.t === 'op') && num === '') {
        num = '-';
        continue;
      }
      out.push({ t: 'op', v: op });
    } else {
      return null;
    }
  }
  if (num === '-') return null;
  if (!flush()) return null;
  return out;
}

/** 計算運算式；結尾多餘的運算子會被忽略（使用者常按到一半就按完成）。錯誤回傳 null。 */
export function evaluate(expr: string): Decimal | null {
  const trimmed = expr.replace(/[+\-−*×/÷]+$/, '');
  if (trimmed === '') return new Decimal(0);
  const toks = tokenize(trimmed);
  if (!toks || toks.length === 0) return null;
  // 先處理乘除
  const stack: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.t === 'op' && (tok.v === '*' || tok.v === '/')) {
      const left = stack.pop();
      const right = toks[++i];
      if (!left || left.t !== 'num' || !right || right.t !== 'num') return null;
      if (tok.v === '/' && right.v.isZero()) return null;
      stack.push({ t: 'num', v: tok.v === '*' ? left.v.mul(right.v) : left.v.div(right.v) });
    } else {
      stack.push(tok);
    }
  }
  // 再處理加減
  let acc: Decimal | null = null;
  let pending: '+' | '-' | null = null;
  for (const tok of stack) {
    if (tok.t === 'num') {
      if (acc === null) acc = tok.v;
      else if (pending === '+') acc = acc.plus(tok.v);
      else if (pending === '-') acc = acc.minus(tok.v);
      else return null;
      pending = null;
    } else {
      if (pending !== null || acc === null) return null;
      pending = tok.v as '+' | '-';
    }
  }
  return acc;
}

/**
 * 鍵盤輸入：回傳新的運算式字串。處理重複運算子、多重小數點、前導 0 等邊界情況。
 * maxDecimals：目前幣別允許的小數位數。
 */
export function pressKey(expr: string, key: string, maxDecimals = 2): string {
  if (key === 'C') return '';
  if (key === '⌫') return expr.slice(0, -1);
  const last = expr.slice(-1);
  const lastNum = expr.split(/[+\-−×÷*/]/).pop() ?? '';
  if (isOperator(key)) {
    if (expr === '') return key === '−' || key === '-' ? '-' : '';
    if (isOperator(last)) return expr === '-' ? expr : expr.slice(0, -1) + key;
    return expr + key;
  }
  if (key === '.') {
    if (maxDecimals === 0 || lastNum.includes('.')) return expr;
    return expr + (lastNum === '' || lastNum === '-' ? '0.' : '.');
  }
  if (/^\d+$/.test(key)) {
    const dot = lastNum.indexOf('.');
    if (dot >= 0 && lastNum.length - dot - 1 + key.length > maxDecimals) return expr;
    // 整數部分最多 12 位，避免超出安全整數
    if (dot < 0 && lastNum.replace('-', '').length + key.length > 12) return expr;
    if (lastNum === '0') return expr.slice(0, -1) + (key === '00' ? '0' : key);
    if (key === '00' && (lastNum === '' || lastNum === '-')) return expr + '0';
    return expr + key;
  }
  return expr;
}
