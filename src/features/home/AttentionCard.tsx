/**
 * 提醒中心（鈴鐺）最上面的「需要你看一下」（4.1.1 起從首頁搬進來；首頁留給快覽）：把原本散在畫面中間的三種提醒併成同一張卡、同一種樣式——
 *   📥 收件匣待確認、🔔 預算預警與 🔎 異常偵測（只讀快取）、✨ AI 上週重點（選用，可收合）。
 * 依重要性排序、最多 4 行；沒有事情要看時整張卡都不出現。
 * v4.1.14：整張卡可以左滑「隱藏」（縮起來再消失）。隱藏的是「當時看到的那些項目」：之後出現新的項目（或收件匣待確認變多、
 * 異常變多、換了新的一週重點）才會再冒出來，只顯示新的；原本隱藏的不會回來，直到它們消失後又再發生。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useInboxTotal } from '@/services/inboxCount';
import { loadSnapshot } from '@/services/insightsCache';
import { useSettings } from '@/stores/settings';
import { AiMark, Icon } from '@/ui/Icon';
import { SwipeRow } from '@/ui/SwipeRow';

const KEY = 'aster.home.weekly.open';
const readOpen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

const HIDE_KEY = 'aster.attn.hidden';
/** 已隱藏的項目：key → 隱藏當時的「量」（收件匣待確認幾筆、幾項異常；其他是 1）。量變大才算新的 */
export type HiddenMap = Record<string, number>;
const readHidden = (): HiddenMap => {
  try { const v = JSON.parse(localStorage.getItem(HIDE_KEY) ?? '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? (v as HiddenMap) : {}; } catch { return {}; }
};
const writeHidden = (h: HiddenMap) => { try { localStorage.setItem(HIDE_KEY, JSON.stringify(h)); } catch { /* 忽略 */ } };
/** 這一項在目前的隱藏紀錄下要不要顯示 */
export const isNewAttention = (hidden: HiddenMap, key: string, amount: number) => amount > (hidden[key] ?? 0);

type Weekly = Awaited<ReturnType<typeof import('@/services/ai').autoWeeklyInsight>>;

export function AttentionCard({ onGo }: { onGo?: () => void }) {
  const navigate = useNavigate();
  const inboxCount = useInboxTotal();
  const cfg = useSettings((s) => s.insights);
  const snap = useLiveQuery(() => loadSnapshot(), []);
  // 除息提醒與每週重點都要用到較大的模組：動態載入，不放進首頁的初始檔案
  const taxRowsRaw = useLiveQuery(async () => (await import('@/services/taxplan')).taxAlertRows(), []);
  const taxRows = taxRowsRaw ?? [];
  const aiAuto = useSettings((s) => !!s.ai?.enabled && !!s.ai?.allowData && !!s.ai?.auto);
  const [weekly, setWeekly] = useState<Weekly>(null);
  const [weeklyDone, setWeeklyDone] = useState(false);
  const [hidden, setHidden] = useState<HiddenMap>(readHidden);
  const [open, setOpen] = useState(readOpen);
  useEffect(() => {
    if (!aiAuto) { setWeekly(null); setWeeklyDone(true); return; }
    let alive = true;
    setWeeklyDone(false);
    void import('@/services/ai').then((m) => m.autoWeeklyInsight()).then((x) => { if (alive) { setWeekly(x); setWeeklyDone(true); } }).catch(() => { if (alive) setWeeklyDone(true); });
    return () => { alive = false; };
  }, [aiAuto]);

  const rows: { key: string; amount: number; icon: string; text: string; tone?: 'danger' | 'warn'; to?: string }[] = [];
  if (cfg?.budgetWarn) for (const w of (snap?.warnings ?? []).filter((w) => w.level === 'over').slice(0, 2)) rows.push({ key: w.id, amount: 1, icon: w.level === 'over' ? '⚠️' : '🔔', text: w.title, tone: w.level === 'over' ? 'danger' : 'warn', to: '/plan?tab=budget' });
  if (inboxCount > 0) rows.push({ key: 'inbox', amount: inboxCount, icon: '📥', text: `收件匣有 ${inboxCount} 筆待確認`, to: '/inbox' });
  const warnN = cfg?.anomaly ? (snap?.findings ?? []).filter((f) => f.severity === 'warn').length : 0;
  if (warnN > 0) rows.push({ key: 'anomaly', amount: warnN, icon: '🔎', text: `${warnN} 項消費異常或疑似重複`, });
  for (const t of taxRows) rows.push({ key: t.key, amount: 1, icon: '📅', text: t.text, tone: 'warn', to: '/reports/tax' });
  const weeklyKey = weekly ? `weekly:${weekly.label}` : '';

  // 隱藏紀錄只保留「現在還存在」的項目：它們消失之後又出現，就算新的。資料都載入完才整理（避免載入中誤刪）
  const ready = snap !== undefined && taxRowsRaw !== undefined && weeklyDone;
  const aliveSig = [...rows.map((r) => r.key), weeklyKey].join('|');
  useEffect(() => {
    if (!ready) return;
    const alive = new Set(aliveSig.split('|'));
    const keep = Object.fromEntries(Object.entries(hidden).filter(([k]) => alive.has(k)));
    if (Object.keys(keep).length !== Object.keys(hidden).length) { setHidden(keep); writeHidden(keep); }
  }, [ready, aliveSig, hidden]);

  const visible = rows.filter((r) => isNewAttention(hidden, r.key, r.amount));
  const showWeekly = !!weekly && isNewAttention(hidden, weeklyKey, 1);
  if (!visible.length && !showWeekly) return null;

  const hideAll = () => {
    const next: HiddenMap = { ...hidden };
    for (const r of rows) next[r.key] = r.amount;
    if (weeklyKey) next[weeklyKey] = 1;
    setHidden(next);
    writeHidden(next);
  };
  const toggleWeekly = () => setOpen((o) => { try { localStorage.setItem(KEY, o ? '0' : '1'); } catch { /* 忽略 */ } return !o; });
  const shown = visible.slice(0, 4);
  return (
    <SwipeRow flat collapse onDelete={hideAll} action={{ label: '隱藏', icon: 'eyeOff' }}>
    <section className="attn-card" aria-label="待處理事項">
      <div className="attn-title">待處理事項</div>
      {shown.map((r) => (
        <button key={r.key} className={`attn-row${r.tone ? ` ${r.tone}` : ''}`} onClick={() => { onGo?.(); navigate(r.to ?? '/ai'); }}>
          <span className="attn-ico" aria-hidden="true">{r.icon}</span>
          <span className="attn-text">{r.text}</span>
          <Icon name="chevronR" size={16} />
        </button>
      ))}
      {showWeekly && weekly && (
        <>
          <button className="attn-row" onClick={toggleWeekly} aria-expanded={open}>
            <span className="attn-ico" aria-hidden="true"><AiMark /></span>
            <span className={`attn-text${open ? '' : ' one'}`}><b>{weekly.label}：</b>{weekly.value.headline}</span>
            <span className={`attn-chev${open ? ' open' : ''}`} aria-hidden="true"><Icon name="chevronD" size={16} /></span>
          </button>
          {open && (
            <div className="attn-more">
              {weekly.value.suggestion && <p>💡 {weekly.value.suggestion}</p>}
              <button className="attn-link" onClick={() => { onGo?.(); navigate('/reports/summary?unit=week'); }}>看完整週報 →</button>
            </div>
          )}
        </>
      )}
    </section>
    </SwipeRow>
  );
}
