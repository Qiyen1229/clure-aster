import { describe, expect, it } from 'vitest';
import { evaluate, hasOperator, pressKey } from '@/domain/calc-expr';

const ev = (s: string) => evaluate(s)?.toString() ?? null;

describe('calc-expr', () => {
  it('四則運算、先乘除後加減', () => {
    expect(ev('100+50')).toBe('150');
    expect(ev('100+50×2')).toBe('200');
    expect(ev('300÷3−20')).toBe('80');
    expect(ev('0.1+0.2')).toBe('0.3');
    expect(ev('-5+10')).toBe('5');
    expect(ev('10×-2')).toBe('-20');
    expect(ev('1,000+1')).toBe('1001');
  });
  it('結尾運算子忽略；錯誤回傳 null', () => {
    expect(ev('120+')).toBe('120');
    expect(ev('')).toBe('0');
    expect(ev('5÷0')).toBeNull();
    expect(ev('1..2')).toBeNull();
    expect(ev('abc')).toBeNull();
  });
  it('hasOperator 不把開頭負號算進去', () => {
    expect(hasOperator('-5')).toBe(false);
    expect(hasOperator('5+1')).toBe(true);
  });
  it('pressKey 邊界', () => {
    let e = '';
    for (const k of ['0', '0', '5']) e = pressKey(e, k);
    expect(e).toBe('5');
    expect(pressKey('12+', '×')).toBe('12×');
    expect(pressKey('', '+')).toBe('');
    expect(pressKey('', '.')).toBe('0.');
    expect(pressKey('1.2', '.')).toBe('1.2');
    expect(pressKey('1.25', '3')).toBe('1.25'); // 超過 2 位小數
    expect(pressKey('100', '.', 0)).toBe('100'); // JPY 不允許小數
    expect(pressKey('12', '⌫')).toBe('1');
    expect(pressKey('12+3', 'C')).toBe('');
    expect(pressKey('5+', '00')).toBe('5+0');
    expect(pressKey('999999999999', '1')).toBe('999999999999');
  });
});
