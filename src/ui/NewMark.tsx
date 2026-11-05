/**
 * 「新功能」標記：標題前的小閃亮符號。只有「最新一批新功能」（src/release.json 的 featureRelease）會亮：
 * 新功能上線時在標題旁放 <NewMark since="版本" />，並把 release.json 的 featureRelease 改成這個版本；
 * 下一批新功能出現時改掉 featureRelease，舊功能的閃光符號就自動全部取消。小修正不要動它。
 */
import { FEATURE_RELEASE } from '@/release';

export const isNewFeature = (since: string, latest: string = FEATURE_RELEASE) => since === latest;

export function NewMark({ since, className }: { since: string; className?: string }) {
  if (!isNewFeature(since)) return null;
  return (
    <span className={`new-mark${className ? ` ${className}` : ''}`} role="img" aria-label="新功能" title="新功能">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <defs>
          <linearGradient id="nm-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FFE27A" /><stop offset="1" stopColor="#FF9F0A" /></linearGradient>
        </defs>
        <path d="M12 2l2.2 6.3L21 10l-6.3 2.2L12 19l-2.2-6.8L3 10l6.8-1.7z" fill="url(#nm-g)" />
        <path d="M19 15l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="#FFD60A" />
      </svg>
    </span>
  );
}
