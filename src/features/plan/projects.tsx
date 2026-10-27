/**
 * 專案／旅行記帳：列表、建立／編輯（期間、幣別、預算）、專案詳情（獨立統計、分類、明細、匯出）。
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Project } from '@/db/types';
import { deleteProject, projectStats, saveProject } from '@/db/repo/plan';
import { eachDay, todayKey } from '@/domain/period';
import { fromMinor, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { useAccounts, useCategories, useTags } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AmountField, CurrencyField, DateField, TextField } from '@/ui/form';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { LedgerRow } from '../ledger/LedgerRow';
import { SectionHead } from './PlanPage';
import { exportCSV, exportXLSX } from '@/services/backup';

export default function ProjectSection() {
  const navigate = useNavigate();
  const [edit, setEdit] = useState<Project | 'new' | null>(null);
  const [status, setStatus] = useState<'active' | 'done'>('active');
  const list = useLiveQuery(() => db.projects.toArray(), []);
  const totals = useLiveQuery(async () => {
    const m = new Map<string, number>();
    for (const p of list ?? []) m.set(p.id, (await projectStats(p)).expense);
    return m;
  }, [list]);

  const shown = (list ?? []).filter((p) => (status === 'active' ? p.status === 'active' : p.status !== 'active')).sort((a, b) => (a.start < b.start ? 1 : -1));
  return (
    <>
      <SectionHead title="專案／旅行" onAdd={() => setEdit('new')} />
      <Segmented value={status} onChange={setStatus} options={[{ value: 'active', label: '進行中' }, { value: 'done', label: '已結束' }]} ariaLabel="專案狀態" />
      {!list ? <SkeletonRows /> : shown.length === 0 ? (
        <EmptyState emoji="🧳" title={status === 'active' ? '沒有進行中的專案' : '沒有已結束的專案'} text="建立「日本旅行」「婚禮」「裝潢」等專案，記帳時選擇專案，就能獨立統計與匯出。"
          action={status === 'active' ? <button className="btn small" onClick={() => setEdit('new')}>建立專案</button> : undefined} />
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {shown.map((p) => {
            const spent = totals?.get(p.id) ?? 0;
            const pct = p.budgetMinor ? (spent / p.budgetMinor) * 100 : 0;
            return (
              <button key={p.id} className="row with-icon" onClick={() => navigate(`/plan/projects/${p.id}`)}>
                <span className="cat-icon" style={{ ['--c' as string]: p.color }} aria-hidden="true">{p.icon}</span>
                <div className="row-main">
                  <div className="row-title">{p.name}</div>
                  <div className="row-sub">{p.start.replace(/-/g, '/')}{p.end ? ` – ${p.end.slice(5).replace('-', '/')}` : ' 起'} · {p.currency}</div>
                  {p.budgetMinor ? <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${Math.min(100, pct)}%`, ['--c' as string]: pct > 100 ? 'var(--danger)' : p.color }} /></div> : null}
                </div>
                <div className="row-end">
                  <Amount minor={spent} currency={p.currency} tone="none" className="num" />
                  {p.budgetMinor ? <div className="row-sub">/ <Amount minor={p.budgetMinor} currency={p.currency} tone="none" /></div> : null}
                </div>
                <Icon name="chevronR" className="row-chev" />
              </button>
            );
          })}
        </div>
      )}
      <ProjectSheet open={edit !== null} project={edit === 'new' ? undefined : edit ?? undefined} onClose={() => setEdit(null)} />
    </>
  );
}

const PROJECT_ICONS = ['🧳', '✈️', '🏝️', '🗾', '💒', '🏠', '🎓', '🚗', '🎉', '👶', '🛠️', '📦'];
const PROJECT_COLORS = ['#0A84FF', '#30D158', '#FF9F0A', '#FF375F', '#BF5AF2', '#64D2FF', '#FFD60A', '#AC8E68'];

export function ProjectSheet({ open, project, onClose }: { open: boolean; project?: Project; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={project ? '編輯專案' : '新增專案'}>
      {open && <ProjectForm key={project?.id ?? 'new'} project={project} onClose={onClose} />}
    </Sheet>
  );
}

function ProjectForm({ project, onClose }: { project?: Project; onClose: () => void }) {
  const base = useSettings((s) => s.baseCurrency);
  const [name, setName] = useState(project?.name ?? '');
  const [icon, setIcon] = useState(project?.icon ?? '🧳');
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
  const [start, setStart] = useState(project?.start ?? todayKey());
  const [end, setEnd] = useState(project?.end ?? '');
  const [currency, setCurrency] = useState(project?.currency ?? base);
  const [budget, setBudget] = useState(project?.budgetMinor ? fromMinor(project.budgetMinor, project.currency).toString() : '');
  const [note, setNote] = useState(project?.note ?? '');
  const navigate = useNavigate();

  const save = async () => {
    if (!name.trim()) { useUI.getState().showSnack({ text: '請輸入專案名稱' }); return; }
    const b = budget ? evaluate(budget) : null;
    const id = await saveProject({
      name: name.trim(), icon, color, start, end: end || undefined, currency, budgetMinor: b && b.gt(0) ? toMinor(b, currency) : undefined,
      status: project?.status ?? 'active', note,
    }, project?.id);
    onClose();
    if (!project) navigate(`/plan/projects/${id}`);
  };

  return (
    <>
      <div className="swatches" role="radiogroup" aria-label="圖示">
        {PROJECT_ICONS.map((i) => <button key={i} className="pill" aria-pressed={icon === i} onClick={() => setIcon(i)} aria-label={i}>{i}</button>)}
      </div>
      <div className="swatches" role="radiogroup" aria-label="顏色">
        {PROJECT_COLORS.map((c) => <button key={c} className="swatch" style={{ ['--c' as string]: c }} aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} />)}
      </div>
      <div className="list">
        <TextField label="名稱" value={name} onChange={setName} placeholder="例如：日本旅行" />
        <DateField label="開始" value={start} onChange={setStart} />
        <DateField label="結束" value={end} onChange={setEnd} min={start} />
        <CurrencyField label="專案幣別" value={currency} onChange={setCurrency} />
        <AmountField label="專案預算" value={budget} onChange={setBudget} currency={currency} placeholder="選填" />
        <TextField label="備註" value={note} onChange={setNote} maxLength={120} />
      </div>
      <button className="btn" onClick={() => void save()}>儲存</button>
      {project && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn secondary" onClick={async () => { await saveProject({ ...project, status: project.status === 'active' ? 'done' : 'active' }, project.id); onClose(); }}>
            {project.status === 'active' ? '標記為已結束' : '重新開啟'}
          </button>
          <button className="btn danger" onClick={async () => {
            if (!window.confirm(`刪除專案「${project.name}」？帳目會保留，只移除專案標記。`)) return;
            await deleteProject(project.id);
            onClose();
            navigate('/plan?tab=project');
          }}>刪除</button>
        </div>
      )}
    </>
  );
}

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const project = useLiveQuery(() => db.projects.get(id), [id]);
  const tick = useLiveQuery(() => db.transactions.where('projectId').equals(id).count(), [id]);
  const stats = useLiveQuery(() => (project ? projectStats(project) : Promise.resolve(null)), [project, tick]);
  const cats = useCategories();
  const accounts = useAccounts(true);
  const tags = useTags();
  const [editing, setEditing] = useState(false);
  const openAdd = useUI((s) => s.openAdd);

  const byCat = useMemo(() => {
    if (!stats) return [];
    const m = new Map<string, number>();
    for (const [cid, v] of stats.byCat) {
      const c = cats.map.get(cid);
      const main = c?.parentId || cid;
      m.set(main, (m.get(main) ?? 0) + v);
    }
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [stats, cats.map]);

  if (project === undefined) return <main className="page"><SkeletonRows /></main>;
  if (!project) return <main className="page"><EmptyState emoji="🤔" title="找不到專案" action={<button className="btn small" onClick={() => navigate('/plan?tab=project')}>回專案列表</button>} /></main>;
  const days = eachDay({ start: project.start, end: project.end && project.end < todayKey() ? project.end : todayKey() }).length || 1;
  const pct = project.budgetMinor && stats ? (stats.expense / project.budgetMinor) * 100 : 0;
  const items = (stats?.txs ?? []).sort((a, b) => (a.date === b.date ? b.ts - a.ts : a.date < b.date ? 1 : -1))
    .map((t) => ({ kind: 'tx' as const, id: t.id, date: t.date, ts: t.ts, tx: t }));

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate('/plan?tab=project')}><Icon name="chevronL" /></button>
        <h1>{project.icon} {project.name}</h1>
        <button className="icon-btn" aria-label="編輯專案" onClick={() => setEditing(true)}><Icon name="edit" /></button>
      </header>
      <section className="card glass">
        <div className="muted" style={{ fontSize: '0.8rem' }}>總花費（{project.currency}）</div>
        <div className="hero-num num"><Amount minor={stats?.expense ?? 0} currency={project.currency} tone="none" animate /></div>
        {project.currency !== stats?.base && stats && <div className="muted num" style={{ fontSize: '0.85rem' }}>≈ <Amount minor={stats.expenseBase} currency={stats.base} tone="none" /></div>}
        {project.budgetMinor ? (
          <>
            <div className="bar" style={{ marginTop: 10 }}><i style={{ width: `${Math.min(100, pct)}%`, ['--c' as string]: pct > 100 ? 'var(--danger)' : project.color }} /></div>
            <div className="muted num" style={{ fontSize: '0.8rem', marginTop: 6 }}>預算 <Amount minor={project.budgetMinor} currency={project.currency} tone="none" />・剩餘 <Amount minor={project.budgetMinor - (stats?.expense ?? 0)} currency={project.currency} tone="auto" /></div>
          </>
        ) : null}
        <div className="stat-grid" style={{ marginTop: 12 }}>
          <div className="stat"><div className="k">筆數</div><div className="v num">{stats?.txs.length ?? 0}</div></div>
          <div className="stat"><div className="k">日均</div><div className="v num"><Amount minor={Math.round((stats?.expense ?? 0) / days)} currency={project.currency} tone="none" /></div></div>
          <div className="stat"><div className="k">天數</div><div className="v num">{days}</div></div>
        </div>
      </section>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn tinted small" style={{ flex: 1 }} onClick={() => openAdd({ projectId: project.id })}>記一筆</button>
        <button className="btn tinted small" style={{ flex: 1 }} onClick={() => void exportCSV({ projectId: project.id }, `aster-${project.name}`)}>匯出 CSV</button>
        <button className="btn tinted small" style={{ flex: 1 }} onClick={() => void exportXLSX({ projectId: project.id }, `aster-${project.name}`)}>匯出 Excel</button>
      </div>
      {byCat.length > 0 && (
        <div className="list">
          {byCat.map(([cid, v]) => {
            const c = cats.map.get(cid);
            const p = stats!.expense ? (v / stats!.expense) * 100 : 0;
            return (
              <div key={cid} className="row with-icon">
                <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true">{c?.icon}</span>
                <div className="row-main">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span>{c?.name} <span className="muted num" style={{ fontSize: '0.8rem' }}>{p.toFixed(1)}%</span></span>
                    <Amount minor={v} currency={project.currency} tone="none" className="num" />
                  </div>
                  <div className="bar"><i style={{ width: `${p}%`, ['--c' as string]: c?.color }} /></div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="section-title">明細</div>
      {items.length === 0 ? <EmptyState emoji="🧾" title="這個專案還沒有帳目" text="記帳時在「專案」選擇它，或點上方「記一筆」。" /> :
        items.map((it) => <LedgerRow key={it.id} item={it} cats={cats.map} accounts={accounts.map} tags={tags.map} showDate />)}
      <ProjectSheet open={editing} project={project} onClose={() => setEditing(false)} />
    </main>
  );
}
