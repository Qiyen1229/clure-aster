/**
 * 首頁「需要你看一下」：把原本散在畫面中間的三種提醒併成同一張卡、同一種樣式——
 *   📥 收件匣待確認、🔔 預算預警與 🔎 異常偵測（只讀快取）、✨ AI 上週重點（選用，可收合）。
 * 依重要性排序、最多 4 行；沒有事情要看時整張卡都不出現。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { autoWeeklyInsight } from '@/services/ai';
import { useInboxCount } from '@/services/inbox';
import { loadSnapshot } from '@/services/insights';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';

const KEY = 'aster.home.weekly.open';
const readOpen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

type Weekly = Awaited<ReturnType<typeof autoWeeklyInsight>>;

export function AttentionCard() {
  const navigate = useNavigate();
  const inboxCount = useInboxCount((s) => s.n);
  const cfg = useSettings((s) => s.insights);
  const snap = useLiveQuery(() => loadSnapshot(), []);
  const aiAuto = useSettings((s) => !!s.ai?.enabled && !!s.ai?.allowData && !!s.ai?.auto);
  const [weekly, setWeekly] = useState<Weekly>(null);
  const [open, setOpen] = useState(readOpen);
  useEffect(() => {
    if (!aiAuto) { setWeekly(null); return; }
    let alive = true;
    void autoWeeklyInsight().then((x) => alive && setWeekly(x)).catch(() => undefined);
    return () => { alive = false; };
  }, [aiAuto]);

  const rows: { key: string; icon: string; text: string; tone?: 'danger' | 'warn'; to: string }[] = [];
  if (cfg?.budgetWarn) for (const w of (snap?.warnings ?? []).slice(0, 2)) rows.push({ key: w.id, icon: w.level === 'over' ? '⚠️' : '🔔', text: w.title, tone: w.level === 'over' ? 'danger' : 'warn', to: '/plan?tab=budget' });
  if (inboxCount > 0) rows.push({ key: 'inbox', icon: '📥', text: `收件匣有 ${inboxCount} 筆待確認`, to: '/inbox' });
  const warnN = cfg?.anomaly ? (snap?.findings ?? []).filter((f) => f.severity === 'warn').length : 0;
  if (warnN > 0) rows.push({ key: 'anomaly', icon: '🔎', text: `${warnN} 項異常或疑似重複，點開看白話說明`, to: '/insights' });
  if (!rows.length && !weekly) return null;

  const toggleWeekly = () => setOpen((o) => { try { localStorage.setItem(KEY, o ? '0' : '1'); } catch { /* 忽略 */ } return !o; });
  const shown = rows.slice(0, 4);
  return (
    <section className="attn-card" aria-label="需要你看一下">
      <div className="attn-title">需要你看一下</div>
      {shown.map((r) => (
        <button key={r.key} className={`attn-row${r.tone ? ` ${r.tone}` : ''}`} onClick={() => navigate(r.to)}>
          <span className="attn-ico" aria-hidden="true">{r.icon}</span>
          <span className="attn-text">{r.text}</span>
          <Icon name="chevronR" size={16} />
        </button>
      ))}
      {weekly && (
        <>
          <button className="attn-row" onClick={toggleWeekly} aria-expanded={open}>
            <span className="attn-ico" aria-hidden="true">✨</span>
            <span className={`attn-text${open ? '' : ' one'}`}><b>{weekly.label}：</b>{weekly.value.headline}</span>
            <span className={`attn-chev${open ? ' open' : ''}`} aria-hidden="true"><Icon name="chevronD" size={16} /></span>
          </button>
          {open && (
            <div className="attn-more">
              {weekly.value.suggestion && <p>💡 {weekly.value.suggestion}</p>}
              <button className="attn-link" onClick={() => navigate('/reports/summary?unit=week')}>看完整週報 →</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
