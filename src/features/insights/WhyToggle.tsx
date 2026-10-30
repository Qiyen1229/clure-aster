/**
 * 「白話說明」展開鈕。說明是用規則與模板在本機產生的（不使用 AI、不計入 AI 額度），可以隨意展開與收合，沒有次數限制。
 */
import { useState } from 'react';
import { Icon } from '@/ui/Icon';

export function WhyToggle({ id, why, tip }: { id: string; why: string; tip: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="insight-why">
      <button className="insight-why-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`why-${id}`}>
        白話說明 <Icon name={open ? 'up' : 'chevronD'} size={14} />
      </button>
      {open && (
        <div id={`why-${id}`} className="insight-why-body">
          <p>{why}</p>
          <p className="insight-tip">💡 {tip}</p>
        </div>
      )}
    </div>
  );
}
