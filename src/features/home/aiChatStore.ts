/**
 * 首頁對話框的狀態（很輕）：對話內容、開關。小圓球（AiOrb）與對話視窗（AiChat，較大、按下圓球才載入）共用。
 */
import { create } from 'zustand';
import type { ResolvedDraft } from '@/services/quickentry';
import type { RawStep, ResolvedStep, ViewSpec } from '@/domain/agent/plan';

/** 預算規劃的一句話（預算頁按鈕、舊連結 /ai?tool=budget 共用） */
export const BUDGET_PROMPT = '依過去 3 個月的花費，幫我設定各分類的每月預算';

export type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; kind: 'text'; text: string; /** 串流中：回答還在生成，文字尾端顯示游標 */ streaming?: boolean; sub?: string; link?: { label: string; to: string }; followups?: string[] }
  | { id: number; role: 'ai'; kind: 'entries'; drafts: ResolvedDraft[]; via: 'rule' | 'ai'; sub?: string; booked?: boolean }
  | { id: number; role: 'ai'; kind: 'agent'; summary: string; steps: ResolvedStep[]; /** AI 規劃的原始步驟：略過某幾步時用它在本機重新預覽，不必再問 AI */ raw: RawStep[]; quota: string; phase?: 'done' | 'undone' | 'cancelled'; opId?: string; note?: string }
  | { id: number; role: 'ai'; kind: 'view'; view: ViewSpec }
  | { id: number; role: 'ai'; kind: 'pending' };

export type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Reply = DistOmit<Extract<Msg, { role: 'ai' }>, 'id'>;

interface ChatState {
  open: boolean;
  msgs: Msg[];
  busy: boolean;
  /** 提問時附上「目前畫面」摘要（預設開；按掉標籤就不附） */
  attach: boolean;
  setAttach: (v: boolean) => void;
  setOpen: (v: boolean) => void;
  /** 等對話視窗載入後自動送出的一句話（搜尋頁的「交給 AI」、預算頁按鈕、舊連結用） */
  pending: string | null;
  ask: (text: string) => void;
  patch: (id: number, p: Partial<Msg>) => void;
  clear: () => void;
}
export let seq = 0;
export const nextSeq = () => ++seq;
export const useChat = create<ChatState>((set) => ({
  open: false, msgs: [], busy: false, attach: true,
  setAttach: (attach) => set({ attach }),
  setOpen: (open) => set({ open }),
  pending: null,
  ask: (text) => set({ open: true, pending: text.slice(0, 300) }),
  patch: (id, p) => set((s) => ({ msgs: s.msgs.map((m) => (m.id === id ? ({ ...m, ...p } as Msg) : m)) })),
  clear: () => set({ msgs: [] }),
}));


/** 開啟對話視窗（輸入框會自動取得焦點） */
export const openAiChat = () => useChat.getState().setOpen(true);
