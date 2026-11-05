/**
 * 「新功能」標記：標題前的小閃亮符號。新功能上線時在標題旁放 <NewMark since="版本" />，
 * 之後自動消失（目前版本比 since 晚兩個次版本以上就不顯示），不用再回頭拿掉。
 */
const ver = (v: string) => { const [a, b] = v.split('.').map(Number); return (a || 0) * 100 + (b || 0); };

export const isNewFeature = (since: string, current = __APP_VERSION__) => { const d = ver(current) - ver(since); return d >= 0 && d <= 2; };

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
