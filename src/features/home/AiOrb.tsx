/**
 * 首頁頂部（搜尋旁）的 AI 小圓球：點一下開啟對話，說一句話記帳或問問題。
 * 圓球顏色跟著主題色；有未清除的對話時右上角有一個小點。這個檔案很輕；對話視窗本身（AiChat）按下才載入。
 */
import { Icon } from '@/ui/Icon';
import { openAiChat, useChat } from './aiChatStore';

export function AiOrb() {
  const hasHistory = useChat((s) => s.msgs.length > 0);
  return (
    <button className={`ai-orb${hasHistory ? ' has-history' : ''}`} aria-label="Cilo：說一句話記帳或問問題" onClick={openAiChat}>
      <Icon name="ai" size={32} />
    </button>
  );
}
