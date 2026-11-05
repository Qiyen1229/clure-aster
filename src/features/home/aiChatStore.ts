/**
 * 首頁對話框的狀態（很輕）：對話內容、開關。小圓球（AiOrb）與對話視窗（AiChat，較大、按下圓球才載入）共用。
 */
import { create } from 'zustand';
import type { ResolvedDraft } from '@/services/quickentry';
import type { ResolvedStep } from '@/domain/agent/plan';

export type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; kind: 'text'; text: string; sub?: string; link?: { label: string; to: string }; followups?: string[] }
  | { id: number; role: 'ai'; kind: 'entries'; drafts: ResolvedDraft[]; via: 'rule' | 'ai'; sub?: string; booked?: boolean }
  | { id: number; role: 'ai'; kind: 'agent'; summary: string; steps: ResolvedStep[]; quota: string; phase?: 'done' | 'undone' | 'cancelled'; opId?: string; note?: string }
  | { id: number; role: 'ai'; kind: 'pending' };

export type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Reply = DistOmit<Extract<Msg, { role: 'ai' }>, 'id'>;

interface ChatState {
  open: boolean;
  msgs: Msg[];
  busy: boolean;
  setOpen: (v: boolean) => void;
  patch: (id: number, p: Partial<Msg>) => void;
  clear: () => void;
}
export let seq = 0;
export const nextSeq = () => ++seq;
export const useChat = create<ChatState>((set) => ({
  open: false, msgs: [], busy: false,
  setOpen: (open) => set({ open }),
  patch: (id, p) => set((s) => ({ msgs: s.msgs.map((m) => (m.id === id ? ({ ...m, ...p } as Msg) : m)) })),
  clear: () => set({ msgs: [] }),
}));


/** 開啟對話視窗（輸入框會自動取得焦點） */
export const openAiChat = () => useChat.getState().setOpen(true);
