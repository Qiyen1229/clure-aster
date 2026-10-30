/**
 * 年度回顧（Year in Review）：類似 Spotify Wrapped 的全螢幕滑頁。點右半邊下一頁、左半邊上一頁，或左右滑動。
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { analyze } from '@/domain/reports';
import { formatMoney } from '@/domain/money';
import { statAmount } from '@/domain/ledger';
import { useCategories } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { usePortfolio } from '@/services/portfolio';
import { Icon } from '@/ui/Icon';
import { EmptyState } from '@/ui/controls';

const GRADIENTS = [
  'linear-gradient(160deg,#0f172a,#1e3a8a 60%,#0891b2)',
  'linear-gradient(160deg,#4c1d95,#be185d)',
  'linear-gradient(160deg,#064e3b,#0d9488 60%,#a3e635)',
  'linear-gradient(160deg,#7c2d12,#ea580c 60%,#facc15)',
  'linear-gradient(160deg,#1e1b4b,#7c3aed 60%,#f472b6)',
  'linear-gradient(160deg,#0c4a6e,#0284c7 50%,#22d3ee)',
  'linear-gradient(160deg,#111827,#374151 50%,#9ca3af)',
];
const WEEK = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

export default function YearReview() {
  const { year = String(new Date().getFullYear()) } = useParams();
  const navigate = useNavigate();
  // 返回上一頁；若是直接開啟（沒有上一頁），回到報表，不要跳出 App
  const close = () => { if ((window.history.state as { idx?: number } | null)?.idx) navigate(-1); else navigate('/reports', { replace: true }); };
  const base = useSettings((s) => s.baseCurrency);
  const cats = useCategories();
  const pf = usePortfolio();
  const [i, setI] = useState(0);
  const touch = useRef<{ x: number; at: number } | null>(null);
  const range = { start: `${year}-01-01`, end: `${year}-12-31` };
  const txs = useLiveQuery(() => db.transactions.where('date').between(range.start, range.end, true, true).filter((t) => !t.deletedAt).toArray(), [year]);
  const prevTxs = useLiveQuery(() => db.transactions.where('date').between(`${Number(year) - 1}-01-01`, `${Number(year) - 1}-12-31`, true, true).filter((t) => !t.deletedAt).toArray(), [year]);

  const a = useMemo(() => (txs ? analyze(txs, cats.map, range, 'expense', new Date().toISOString().slice(0, 10)) : null), [txs, cats.map]); // eslint-disable-line react-hooks/exhaustive-deps
  const prev = useMemo(() => (prevTxs ? analyze(prevTxs, cats.map, { start: `${Number(year) - 1}-01-01`, end: `${Number(year) - 1}-12-31` }) : null), [prevTxs, cats.map, year]);
  const f = (v: number) => formatMoney(v, base);

  if (!a || !txs) return <div className="wrapped" style={{ background: GRADIENTS[0] }} />;
  if (a.count === 0) return <main className="page"><EmptyState emoji="🎁" title={`${year} 年還沒有資料`} action={<button className="btn small" onClick={close}>返回</button>} /></main>;

  const topCat = [...a.byMain].sort((x, y) => y[1] - x[1])[0];
  const topCatInfo = topCat ? cats.map.get(topCat[0]) : undefined;
  const busiest = [...a.byDay].sort((x, y) => y[1].expense - x[1].expense)[0];
  const months = [...a.byMonth].sort((x, y) => y[1].expense - x[1].expense);
  const days = new Set(txs.map((t) => t.date)).size;
  const delta = prev && prev.expense ? ((a.expense - prev.expense) / prev.expense) * 100 : null;

  const slides: { title: string; big: string; sub?: string; emoji: string }[] = [
    { emoji: '🎁', title: `你的 ${year}`, big: '年度回顧', sub: '準備好看看你的錢都去哪了嗎？點一下開始 →' },
    { emoji: '🧾', title: '這一年你記了', big: `${a.count.toLocaleString()} 筆`, sub: `橫跨 ${days} 天，平均每天花 ${f(a.dailyAvg)}` },
    { emoji: '💸', title: '總支出', big: f(a.expense), sub: delta === null ? `總收入 ${f(a.income)}` : `比去年${delta >= 0 ? '多' : '少'}了 ${Math.abs(delta).toFixed(1)}%` },
    ...(topCatInfo ? [{ emoji: topCatInfo.icon, title: '你最愛把錢花在', big: topCatInfo.name, sub: `${f(topCat[1])}，佔總支出 ${((topCat[1] / a.expense) * 100).toFixed(1)}%` }] : []),
    ...(a.topNotes[0] ? [{ emoji: '🔁', title: '最常出現的項目', big: a.topNotes[0].note, sub: `${a.topNotes[0].count} 次，共 ${f(a.topNotes[0].amount)}` }] : []),
    ...(a.maxTx ? [{ emoji: '🏆', title: '年度最大一筆', big: f(statAmount(a.maxTx)), sub: `${a.maxTx.date.slice(5).replace('-', '/')}・${a.maxTx.note || cats.map.get(a.maxTx.categoryId)?.name}` }] : []),
    ...(busiest ? [{ emoji: '🔥', title: '最燒錢的一天', big: busiest[0].slice(5).replace('-', '/'), sub: `那天花了 ${f(busiest[1].expense)}` }] : []),
    { emoji: '📅', title: '你最常在這時候花錢', big: `${WEEK[a.topWeekday]} ${a.topHour}:00`, sub: months[0] ? `花最多的月份是 ${Number(months[0][0].slice(5))} 月（${f(months[0][1].expense)}）` : undefined },
    ...(a.savingRate !== null ? [{ emoji: a.savingRate >= 20 ? '🐷' : '🌱', title: '年度儲蓄率', big: `${a.savingRate.toFixed(1)}%`, sub: `存下了 ${f(a.net)}${a.savingRate >= 20 ? '，太強了！' : '，明年再加油 💪'}` }] : []),
    ...(pf && pf.investedBase > 0 ? [{ emoji: '📈', title: '投資成績', big: `${pf.totalReturnWithDivPct >= 0 ? '+' : ''}${pf.totalReturnWithDivPct.toFixed(1)}%`, sub: `含股利總報酬・今年股利 ${f(pf.dividendsThisYearBase)}` }] : []),
    { emoji: '✨', title: `${year} 謝謝你認真記帳`, big: `${Number(year) + 1} 見！`, sub: '截圖分享給朋友吧' },
  ];
  const s = slides[Math.min(i, slides.length - 1)];
  const go = (d: number) => setI((x) => Math.max(0, Math.min(slides.length - 1, x + d)));

  return (
    <div className="wrapped" style={{ background: GRADIENTS[i % GRADIENTS.length] }}
      onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, at: 0 }; }}
      onTouchEnd={(e) => {
        if (!touch.current) return;
        const dx = e.changedTouches[0].clientX - touch.current.x;
        // 滑動才在這裡處理；點一下交給 onClick
        if (Math.abs(dx) > 40) { go(dx < 0 ? 1 : -1); touch.current = { x: 0, at: Date.now() }; } else touch.current = null;
      }}
      onClick={(e) => { if (touch.current && Date.now() - touch.current.at < 500) return; go(e.clientX > window.innerWidth / 2 ? 1 : -1); }}
      onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === ' ') go(1); if (e.key === 'ArrowLeft') go(-1); if (e.key === 'Escape') close(); }}
      tabIndex={0} role="region" aria-roledescription="輪播" aria-label={`${year} 年度回顧，第 ${i + 1} 頁，共 ${slides.length} 頁`}>
      <div className="wrapped-progress" aria-hidden="true">
        {slides.map((_, k) => <i key={k} className={k <= i ? 'on' : ''} />)}
      </div>
      <button className="wrapped-close" aria-label="關閉" onClick={(e) => { e.stopPropagation(); close(); }}><Icon name="close" /></button>
      <div className="wrapped-slide" key={i} aria-live="polite">
        <div className="wrapped-emoji" aria-hidden="true">{s.emoji}</div>
        <div className="wrapped-title">{s.title}</div>
        <div className="wrapped-big num">{s.big}</div>
        {s.sub && <div className="wrapped-sub">{s.sub}</div>}
      </div>
    </div>
  );
}
