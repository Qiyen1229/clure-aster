/** 耐用品「自訂預計使用期限」彈窗：年與月各填一格（例如 1 年 6 個月、或只填 8 個月） */
import { useEffect, useState } from 'react';
import { lifeLabel, lifeYearsFrom, MAX_LIFE_MONTHS, splitLife } from '@/domain/durable';
import { Sheet } from '@/ui/Sheet';
import { TextField } from '@/ui/form';

const num = (t: string) => Math.max(0, parseInt(t, 10) || 0);

export function LifeSpanSheet({ open, initialYears, onClose, onConfirm }: {
  open: boolean; initialYears: number; onClose: () => void; onConfirm: (lifeYears: number) => void;
}) {
  const [y, setY] = useState('');
  const [m, setM] = useState('');
  useEffect(() => {
    if (!open) return;
    const s = splitLife(initialYears);
    setY(s.years ? String(s.years) : ''); setM(s.months ? String(s.months) : '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const years = lifeYearsFrom(num(y), num(m));
  const tooLong = num(y) * 12 + num(m) > MAX_LIFE_MONTHS;
  return (
    <Sheet open={open} onClose={onClose} title="自訂使用期限">
      <p className="muted" style={{ fontSize: '0.85rem', margin: '0 4px 10px' }}>預計這個東西可以用多久？年和月可以只填其中一個（例如只填 8 個月）。</p>
      <div className="list">
        <TextField label="年" value={y} onChange={(v) => setY(v.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" placeholder="0" />
        <TextField label="月" value={m} onChange={(v) => setM(v.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder="0" />
      </div>
      <p className="muted num" style={{ fontSize: '0.9rem', margin: '10px 4px 14px', minHeight: '1.3em' }}>
        {tooLong ? '最長 100 年' : years > 0 ? `共 ${lifeLabel(years)}` : '請輸入年或月'}
      </p>
      <button className="btn" disabled={years <= 0} onClick={() => { onConfirm(years); onClose(); }}>確定</button>
    </Sheet>
  );
}
