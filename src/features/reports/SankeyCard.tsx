/**
 * 資金流向桑基圖：錢從哪裡來、流到哪裡去（收入來源 → 總收入 → 必要／非必要／投資／淨儲蓄 → 分類／帳戶）。
 * 資料轉換在 domain/sankey.ts；這裡只負責排版與互動：切換「主分類／含子分類」、調整哪些主分類算必要支出、點分類看明細。
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import type { Account, Category, Transaction } from '@/db/types';
import { buildSankey, DEFAULT_ESSENTIAL_MAIN_IDS } from '@/domain/sankey';
import { formatMoney } from '@/domain/money';
import { useSettings } from '@/stores/settings';
import { Segmented } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { chartTheme } from './chart-theme';

const EChart = lazy(() => import('./EChart'));

export function SankeyCard({ txs, cats, accounts, base, onOpenCategory }: {
  txs: Transaction[];
  cats: Map<string, Category>;
  accounts: Map<string, Account>;
  base: string;
  onOpenCategory: (catId: string, isMain: boolean) => void;
}) {
  const stored = useSettings((s) => s.sankeyEssential);
  const set = useSettings((s) => s.set);
  const themeKey = useSettings((s) => `${s.theme}-${s.accent}`); // 換主題時重新取色
  const [depth, setDepth] = useState<'main' | 'sub'>('main');
  const [adjust, setAdjust] = useState(false);
  const essential = useMemo(() => new Set(stored ?? DEFAULT_ESSENTIAL_MAIN_IDS), [stored]);
  const model = useMemo(() => buildSankey(txs, cats, accounts, { essentialMainIds: essential, depth }), [txs, cats, accounts, essential, depth]);
  const mains = useMemo(() => [...cats.values()].filter((c) => c.kind === 'expense' && !c.parentId && !c.system && !c.archived).sort((a, b) => a.sort - b.sort), [cats]);

  const option = useMemo(() => {
    void themeKey; // 換主題時要重新取色
    const t = chartTheme();
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: { dataType: string; data: { label?: string; source?: string; target?: string; value: number } }) => {
          if (p.dataType === 'edge') {
            const s = model.nodes.find((n) => n.id === p.data.source)?.label ?? '', g = model.nodes.find((n) => n.id === p.data.target)?.label ?? '';
            return `${s} → ${g}<br/><b>${formatMoney(p.data.value, base)}</b>`;
          }
          return `${p.data.label}<br/><b>${formatMoney(p.data.value, base)}</b>`;
        },
      },
      series: [{
        type: 'sankey', left: 6, right: 74, top: 8, bottom: 8, nodeAlign: 'justify', nodeWidth: 10, nodeGap: 14, layoutIterations: 48,
        draggable: false, emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', opacity: 0.38, curveness: 0.5 },
        label: { color: t.text, fontSize: 11, formatter: (p: { data: { label: string } }) => p.data.label },
        data: model.nodes.map((n) => ({ name: n.id, label: n.label, itemStyle: { color: n.color ?? t.accent, borderWidth: 0 } })),
        links: model.links,
      }],
    };
  }, [model, base, themeKey]);

  const maxCol = Math.max(0, ...[...model.nodes.reduce((m, n) => m.set(n.column, (m.get(n.column) ?? 0) + 1), new Map<number, number>()).values()]);
  const height = Math.min(660, Math.max(320, maxCol * 36 + 60)); // 節點多時拉高，標籤才不會疊在一起
  const money = (v: number) => formatMoney(v, base, { compact: true });

  return (
    <section className="card" aria-label="資金流向">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 600, flex: 1 }}>資金流向</span>
        <button className="icon-btn" aria-label="調整必要支出分類" onClick={() => setAdjust(true)}><Icon name="sliders" size={18} /></button>
        <div style={{ width: 132 }}>
          <Segmented value={depth} onChange={setDepth} ariaLabel="層級" options={[{ value: 'main', label: '主分類' }, { value: 'sub', label: '子分類' }]} />
        </div>
      </div>
      {model.empty ? <p className="muted" style={{ textAlign: 'center' }}>這段期間沒有收支，畫不出流向</p> : (
        <>
          <Suspense fallback={<div className="skeleton" style={{ height }} />}>
            <EChart option={option} height={height} ariaLabel="資金流向桑基圖"
              onClick={(p) => {
                if (p.data?.name === undefined) return;
                const id = String(p.data.name);
                if (id.startsWith('m:') || id.startsWith('i:')) onOpenCategory(id.slice(2), true);
                else if (id.startsWith('s:') && !id.endsWith(':rest')) onOpenCategory(id.slice(2), false);
              }} />
          </Suspense>
          <div className="stat-grid" style={{ marginTop: 8 }}>
            <div className="stat"><div className="k">收入</div><div className="v num">{money(model.income)}</div></div>
            <div className="stat"><div className="k">消費支出</div><div className="v num">{money(model.expense)}</div></div>
            {model.investing > 0 && <div className="stat"><div className="k">投資買進</div><div className="v num">{money(model.investing)}</div></div>}
            {model.deficit > 0
              ? <div className="stat"><div className="k">動用存款</div><div className="v num" style={{ color: 'var(--danger)' }}>{money(model.deficit)}</div></div>
              : <div className="stat"><div className="k">淨儲蓄</div><div className="v num">{money(model.saving)}</div></div>}
          </div>
          <p className="muted" style={{ fontSize: '0.72rem', margin: '8px 0 0' }}>
            點分類看明細。淨儲蓄依各帳戶本期的淨流入分配；轉帳不是收支，不在圖裡；分帳只算你的份額。支出多於收入時，差額標示為「動用存款」。
          </p>
        </>
      )}

      <Sheet open={adjust} onClose={() => setAdjust(false)} title="哪些算「必要支出」"
        left={<button className="accent" style={{ minHeight: 44 }} onClick={() => set('sankeyEssential', null)}>還原預設</button>}
        right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={() => setAdjust(false)}>完成</button>}>
        <div style={{ padding: '0 16px 24px' }}>
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>點選的主分類算「必要支出」（例如房租、交通、醫療），其餘算「非必要支出」。每個人的標準不同，依自己的生活調整。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {mains.map((c) => (
              <button key={c.id} className="pill" aria-pressed={essential.has(c.id)}
                onClick={() => { const next = new Set(essential); if (next.has(c.id)) next.delete(c.id); else next.add(c.id); set('sankeyEssential', [...next]); }}>
                {c.icon} {c.name}
              </button>
            ))}
          </div>
        </div>
      </Sheet>
    </section>
  );
}
