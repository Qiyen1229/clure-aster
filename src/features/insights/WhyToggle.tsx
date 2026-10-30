/**
 * 「白話說明」展開鈕：展開時才顯示說明，並計入「5 分鐘最多 10 次」的使用限制。
 * 說明是用規則與模板在本機產生的，不使用 AI、不計入 AI 額度；同一個項目展開過一次，同一次停留在頁面上再收合／展開不重複計次。
 */
import { useRef, useState } from 'react';
import { consume, type LimitKey } from '@/services/usageLimit';
import { Icon } from '@/ui/Icon';

export function WhyToggle({ id, limitKey, why, tip }: { id: string; limitKey: LimitKey; why: string; tip: string }) {
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState('');
  const counted = useRef(false);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    if (!counted.current) {
      const r = consume(limitKey);
      if (!r.ok) { setBlocked(r.message); return; }
      counted.current = true;
    }
    setBlocked('');
    setOpen(true);
  };
  return (
    <div className="insight-why">
      <button className="insight-why-btn" onClick={toggle} aria-expanded={open} aria-controls={`why-${id}`}>
        白話說明 <Icon name={open ? 'up' : 'chevronD'} size={14} />
      </button>
      {blocked && <p className="insight-limit" role="status">{blocked}</p>}
      {open && (
        <div id={`why-${id}`} className="insight-why-body">
          <p>{why}</p>
          <p className="insight-tip">💡 {tip}</p>
        </div>
      )}
    </div>
  );
}
