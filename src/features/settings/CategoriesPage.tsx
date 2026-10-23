/**
 * 分類管理：支出／收入兩層分類，新增、改名、改圖示與顏色、上下移動排序、封存／刪除。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Category, CategoryKind } from '@/db/types';
import { addCategory, buildTree, deleteOrArchiveCategory, reorderCategories, updateCategory } from '@/db/repo/categories';
import { CATEGORY_COLORS, OTHER_SUB_NAME } from '@/db/seed/categories';
import { useCategories } from '@/app/hooks';
import { useUI } from '@/stores/ui';
import { Segmented } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

type Edit = { cat?: Category; parentId: string; kind: CategoryKind } | null;

export default function CategoriesPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<string>('');
  const [edit, setEdit] = useState<Edit>(null);
  const { all } = useCategories();
  const tree = useMemo(() => buildTree(all, kind, showArchived), [all, kind, showArchived]);

  const move = async (list: Category[], c: Category, dir: -1 | 1) => {
    const i = list.findIndex((x) => x.id === c.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await reorderCategories(ids);
  };

  const row = (c: Category, siblings: Category[], isSub: boolean) => (
    <div key={c.id} className="row with-icon" style={{ paddingLeft: isSub ? 40 : 16, opacity: c.archived ? 0.5 : 1 }}>
      <button style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0, minHeight: 44, textAlign: 'left' }}
        onClick={() => (isSub ? setEdit({ cat: c, parentId: c.parentId, kind }) : setExpanded((e) => (e === c.id ? '' : c.id)))}>
        <span className={`cat-icon${isSub ? ' sm' : ''}`} style={{ ['--c' as string]: c.color }} aria-hidden="true">{c.icon}</span>
        <span className="row-main row-title">{c.name}{c.archived ? '（已封存）' : ''}</span>
        {!isSub && <Icon name={expanded === c.id ? 'chevronD' : 'chevronR'} className="row-chev" />}
      </button>
      <button className="icon-btn plain" aria-label={`${c.name} 上移`} onClick={() => void move(siblings, c, -1)}><Icon name="up" size={18} /></button>
      <button className="icon-btn plain" aria-label={`${c.name} 下移`} onClick={() => void move(siblings, c, 1)}><Icon name="down" size={18} /></button>
      {!isSub && <button className="icon-btn plain" aria-label={`編輯 ${c.name}`} onClick={() => setEdit({ cat: c, parentId: '', kind })}><Icon name="edit" size={18} /></button>}
    </div>
  );

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>分類</h1>
        <button className="icon-btn" aria-label="新增主分類" onClick={() => setEdit({ parentId: '', kind })}><Icon name="plus" /></button>
      </header>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }]} ariaLabel="分類類型" />
      <div className="list" style={{ marginTop: 12 }}>
        {tree.map(({ main, subs }) => (
          <div key={main.id}>
            {row(main, tree.map((t) => t.main), false)}
            {expanded === main.id && (
              <>
                {subs.map((s) => row(s, subs, true))}
                <button className="row" style={{ paddingLeft: 40 }} onClick={() => setEdit({ parentId: main.id, kind })}>
                  <Icon name="plus" size={18} /><span className="row-main accent">新增「{main.name}」的子分類</span>
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <button className="btn secondary small" onClick={() => setShowArchived((s) => !s)}>{showArchived ? '隱藏已封存' : '顯示已封存'}</button>
      <CategoryEditor edit={edit} onClose={() => setEdit(null)} />
    </main>
  );
}

function CategoryEditor({ edit, onClose }: { edit: Edit; onClose: () => void }) {
  return (
    <Sheet open={!!edit} onClose={onClose} title={edit?.cat ? '編輯分類' : edit?.parentId ? '新增子分類' : '新增分類'}>
      {edit && <EditorBody key={edit.cat?.id ?? `new-${edit.parentId}`} edit={edit} onClose={onClose} />}
    </Sheet>
  );
}

function EditorBody({ edit, onClose }: { edit: NonNullable<Edit>; onClose: () => void }) {
  const [name, setName] = useState(edit.cat?.name ?? '');
  const [icon, setIcon] = useState(edit.cat?.icon ?? '');
  const [color, setColor] = useState(edit.cat?.color ?? CATEGORY_COLORS[0]);
  const snack = (text: string) => useUI.getState().showSnack({ text });
  const save = async () => {
    if (!name.trim()) return snack('請輸入名稱');
    if (edit.cat) await updateCategory(edit.cat.id, { name: name.trim(), icon: icon || '🏷️', color });
    else await addCategory({ kind: edit.kind, parentId: edit.parentId, name: name.trim(), icon: icon || '🏷️', color });
    onClose();
  };
  return (
    <>
      <div className="list">
        <div className="field"><label htmlFor="c-name">名稱</label><input id="c-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={12} /></div>
        <div className="field"><label htmlFor="c-icon">圖示 emoji</label><input id="c-icon" value={icon} onChange={(e) => setIcon([...e.target.value].slice(-2).join(''))} placeholder="🏷️" /></div>
      </div>
      {!edit.parentId && (
        <div className="swatches" role="radiogroup" aria-label="顏色">
          {CATEGORY_COLORS.map((c) => <button key={c} className="swatch" style={{ ['--c' as string]: c }} aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} />)}
        </div>
      )}
      <button className="btn" style={{ marginTop: 12 }} onClick={() => void save()}>儲存</button>
      {edit.cat && !edit.cat.system && edit.cat.parentId && edit.cat.name === OTHER_SUB_NAME && (
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: 10 }}>每個分類都固定保留「其他」子分類，無法封存或刪除。</p>
      )}
      {edit.cat && !edit.cat.system && !(edit.cat.parentId && edit.cat.name === OTHER_SUB_NAME) && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn secondary" onClick={async () => { await updateCategory(edit.cat!.id, { archived: edit.cat!.archived ? 0 : 1 }); onClose(); }}>
            {edit.cat.archived ? '取消封存' : '封存'}
          </button>
          <button className="btn danger" onClick={async () => {
            if (!window.confirm(`刪除「${edit.cat!.name}」？已被使用的分類會改為封存。`)) return;
            const r = await deleteOrArchiveCategory(edit.cat!.id);
            snack(r === 'deleted' ? '已刪除' : '分類已有帳目，已改為封存');
            onClose();
          }}>刪除</button>
        </div>
      )}
    </>
  );
}
