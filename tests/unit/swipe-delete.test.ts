/**
 * 左滑刪除佇列（v4.1.38）：延遲 3 秒寫入、復原、連續刪除時上一筆立刻確定、卸載時 flush。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeleteQueue, UNDO_MS } from '@/ui/useSwipeDelete';
import { useUI } from '@/stores/ui';

describe('createDeleteQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUI.setState({ snack: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('request 後列先隱藏、3 秒到才真的刪除，提示附「復原」與倒數', () => {
    const ids: Set<string>[] = [];
    const commit = vi.fn();
    const q = createDeleteQueue((s) => ids.push(s));
    q.request('p1', '日本旅行', commit);

    expect(ids.at(-1)?.has('p1')).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    const snack = useUI.getState().snack;
    expect(snack?.text).toBe('已刪除「日本旅行」');
    expect(snack?.actionLabel).toBe('復原');
    expect(snack?.duration).toBe(UNDO_MS);

    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(ids.at(-1)?.size).toBe(0);
    expect(useUI.getState().snack).toBeNull();
  });

  it('3 秒內按復原：不刪除、列回來、提示收起', () => {
    const ids: Set<string>[] = [];
    const commit = vi.fn();
    const q = createDeleteQueue((s) => ids.push(s));
    q.request('g1', '旅遊基金', commit);
    useUI.getState().snack?.onAction?.();

    expect(commit).not.toHaveBeenCalled();
    expect(ids.at(-1)?.size).toBe(0);
    expect(useUI.getState().snack).toBeNull();
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('時間到之後復原鍵失效：不會重複刪除或報錯', () => {
    const commit = vi.fn();
    const q = createDeleteQueue(() => {});
    q.request('x', '項目', commit);
    const undo = useUI.getState().snack?.onAction;
    vi.advanceTimersByTime(UNDO_MS);
    expect(commit).toHaveBeenCalledTimes(1);
    undo?.();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('連續刪兩筆：上一筆立刻確定刪除，復原只救最新一筆', () => {
    const ids: Set<string>[] = [];
    const commitA = vi.fn();
    const commitB = vi.fn();
    const q = createDeleteQueue((s) => ids.push(s));
    q.request('a', 'A', commitA);
    vi.advanceTimersByTime(1000);
    q.request('b', 'B', commitB);

    expect(commitA).toHaveBeenCalledTimes(1);
    expect(commitB).not.toHaveBeenCalled();
    expect(ids.at(-1)?.has('a')).toBe(false);
    expect(ids.at(-1)?.has('b')).toBe(true);

    useUI.getState().snack?.onAction?.();
    expect(commitB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(commitA).toHaveBeenCalledTimes(1);
    expect(commitB).not.toHaveBeenCalled();
  });

  it('flushAll（離開頁面）：待刪項目直接寫入並收起提示', () => {
    const ids: Set<string>[] = [];
    const commit = vi.fn();
    const q = createDeleteQueue((s) => ids.push(s));
    q.request('w1', '降噪耳機', commit);
    q.flushAll();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(ids.at(-1)?.size).toBe(0);
    expect(useUI.getState().snack).toBeNull();
    q.flushAll();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('復原後再刪同一筆：可以重新排入佇列', () => {
    const commit = vi.fn();
    const q = createDeleteQueue(() => {});
    q.request('r1', '房租', commit);
    q.undo();
    expect(commit).not.toHaveBeenCalled();
    q.request('r1', '房租', commit);
    vi.advanceTimersByTime(UNDO_MS);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('只收起自己的提示：期間出現別的 snack 不被誤關', () => {
    const q = createDeleteQueue(() => {});
    q.request('s1', '訂閱', () => {});
    useUI.getState().showSnack({ text: '已入帳' });
    vi.advanceTimersByTime(UNDO_MS);
    expect(useUI.getState().snack?.text).toBe('已入帳');
  });
});