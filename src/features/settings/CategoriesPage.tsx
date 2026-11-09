/**
 * 分類管理：支出／收入兩層分類。
 * 簡潔直覺介面：主分類清楚展示、點開為子分類膠囊；右上角可切換「排序模式」，平時不被上下箭頭干擾。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Category, CategoryKind } from '@/db/types';
import { addCategory, buildTree, deleteOrArchiveCategory, reorderCategories, updateCategory } from '@/db/repo/categories';
import { CATEGORY_COLORS, OTHER_SUB_NAME } from '@/db/seed/categories';
import { useCategories } from '@/app/hooks';
import { useUI, ask } from '@/stores/ui';
import { Segmented } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

type Edit = { cat?: Category; parentId: string; kind: CategoryKind } | null;

export default function CategoriesPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<string>('');
  const [reordering, setReordering] = useState(false);
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

  return (
    <main className="page categories-page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>分類管理</h1>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className={`btn small ${reordering ? '' : 'secondary'}`}
            style={{ minHeight: 32, padding: '0 10px', fontSize: '0.82rem' }}
            onClick={() => setReordering((r) => !r)}
          >
            {reordering ? '完成' : '排序'}
          </button>
          <button className="icon-btn" aria-label="新增主分類" onClick={() => setEdit({ parentId: '', kind })}>
            <Icon name="plus" />
          </button>
        </div>
      </header>

      <Segmented
        value={kind}
        onChange={setKind}
        options={[{ value: 'expense', label: '支出分類' }, { value: 'income', label: '收入分類' }]}
        ariaLabel="分類類型"
      />

      <div className="cat-manage-list" style={{ marginTop: 14 }}>
        {tree.map(({ main, subs }) => {
          const isOpen = expanded === main.id;
          return (
            <div key={main.id} className={`cat-card ${main.archived ? 'archived' : ''}`}>
              <div className="cat-card-header">
                <button
                  type="button"
                  className="cat-card-main"
                  onClick={() => setExpanded((e) => (e === main.id ? '' : main.id))}
                >
                  <span className="cat-icon" style={{ ['--c' as string]: main.color }} aria-hidden="true">
                    {main.icon}
                  </span>
                  <div className="cat-card-info">
                    <span className="cat-card-title">
                      {main.name}{main.archived ? '（已封存）' : ''}
                    </span>
                    <span className="cat-card-count">
                      {subs.length} 個子分類
                    </span>
                  </div>
                  <Icon name={isOpen ? 'chevronD' : 'chevronR'} className="cat-chev" />
                </button>

                {reordering ? (
                  <div className="cat-reorder-btns">
                    <button
                      type="button"
                      className="icon-btn plain"
                      aria-label={`${main.name} 上移`}
                      onClick={() => void move(tree.map((t) => t.main), main, -1)}
                    >
                      <Icon name="up" size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn plain"
                      aria-label={`${main.name} 下移`}
                      onClick={() => void move(tree.map((t) => t.main), main, 1)}
                    >
                      <Icon name="down" size={17} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="icon-btn plain cat-edit-btn"
                    aria-label={`編輯 ${main.name}`}
                    title="編輯主分類"
                    onClick={() => setEdit({ cat: main, parentId: '', kind })}
                  >
                    <Icon name="edit" size={16} />
                  </button>
                )}
              </div>

              {isOpen && (
                <div className="cat-sub-wrap">
                  <div className="cat-chips">
                    {subs.map((s) => (
                      <div key={s.id} className="cat-sub-item">
                        <button
                          type="button"
                          className={`cat-chip ${s.archived ? 'archived' : ''}`}
                          onClick={() => setEdit({ cat: s, parentId: s.parentId, kind })}
                        >
                          <span className="cat-chip-icon">{s.icon}</span>
                          <span className="cat-chip-name">{s.name}{s.archived ? ' (封存)' : ''}</span>
                        </button>
                        {reordering && (
                          <div className="cat-sub-move">
                            <button
                              type="button"
                              className="icon-btn plain tiny"
                              onClick={() => void move(subs, s, -1)}
                              aria-label="上移"
                            >
                              <Icon name="up" size={12} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn plain tiny"
                              onClick={() => void move(subs, s, 1)}
                              aria-label="下移"
                            >
                              <Icon name="down" size={12} />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    {!reordering && (
                      <button
                        type="button"
                        className="cat-chip add"
                        onClick={() => setEdit({ parentId: main.id, kind })}
                      >
                        <Icon name="plus" size={14} />
                        <span>新增子分類</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ textAlign: 'center', margin: '20px 0 10px' }}>
        <button
          type="button"
          className="btn secondary small"
          onClick={() => setShowArchived((s) => !s)}
        >
          {showArchived ? '隱藏已封存分類' : '顯示已封存分類'}
        </button>
      </div>

      <CategoryEditor edit={edit} onClose={() => setEdit(null)} />
    </main>
  );
}

function CategoryEditor({ edit, onClose }: { edit: Edit; onClose: () => void }) {
  return (
    <Sheet open={!!edit} onClose={onClose} title={edit?.cat ? '編輯分類' : edit?.parentId ? '新增子分類' : '新增主分類'}>
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
        <div className="field">
          <label htmlFor="c-name">名稱</label>
          <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={12} placeholder="分類名稱" />
        </div>
        <div className="field">
          <label htmlFor="c-icon">圖示 emoji</label>
          <input id="c-icon" value={icon} onChange={(e) => setIcon([...e.target.value].slice(-2).join(''))} placeholder="🏷️" />
        </div>
      </div>
      {!edit.parentId && (
        <div className="swatches" role="radiogroup" aria-label="顏色">
          {CATEGORY_COLORS.map((c) => (
            <button key={c} className="swatch" style={{ ['--c' as string]: c }} aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} />
          ))}
        </div>
      )}
      <button className="btn" style={{ marginTop: 14 }} onClick={() => void save()}>儲存</button>
      {edit.cat && !edit.cat.system && edit.cat.parentId && edit.cat.name === OTHER_SUB_NAME && (
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: 10, textAlign: 'center' }}>每個分類都固定保留「其他」子分類，無法封存或刪除。</p>
      )}
      {edit.cat && !edit.cat.system && !(edit.cat.parentId && edit.cat.name === OTHER_SUB_NAME) && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn secondary" onClick={async () => { await updateCategory(edit.cat!.id, { archived: edit.cat!.archived ? 0 : 1 }); onClose(); }}>
            {edit.cat.archived ? '取消封存' : '封存'}
          </button>
          <button className="btn danger" onClick={async () => {
            if (!await ask(`刪除「${edit.cat!.name}」？已被使用的分類會改為封存。`)) return;
            const r = await deleteOrArchiveCategory(edit.cat!.id);
            snack(r === 'deleted' ? '已刪除' : '分類已有帳目，已改為封存');
            onClose();
          }}>刪除</button>
        </div>
      )}
    </>
  );
}
