/**
 * 分類管理：支出／收入兩層分類。
 * 全新長按拖動排序：卡片長按懸停浮起、1:1 即時跟手、相鄰平滑避讓與觸覺反饋；
 * 告別繁瑣的箭頭與模式切換，還原純粹直覺的互動體驗。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Category, CategoryKind } from '@/db/types';
import { addCategory, buildTree, deleteOrArchiveCategory, reorderCategories, updateCategory } from '@/db/repo/categories';
import { CATEGORY_COLORS, OTHER_SUB_NAME } from '@/db/seed/categories';
import { useCategories } from '@/app/hooks';
import { useUI, ask } from '@/stores/ui';
import { Segmented } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { haptic } from '@/services/haptics';

type Edit = { cat?: Category; parentId: string; kind: CategoryKind } | null;

interface DragState {
  activeId: string;
  startIndex: number;
  overIndex: number;
  startY: number;
  currentY: number;
  itemHeights: number[];
}

export default function CategoriesPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<string>('');
  const [edit, setEdit] = useState<Edit>(null);
  const { all } = useCategories();
  const tree = useMemo(() => buildTree(all, kind, showArchived), [all, kind, showArchived]);

  // 本地順序狀態（拖動時即時響應，放手後寫回資料庫）
  const [orderedList, setOrderedList] = useState(tree);
  useEffect(() => {
    setOrderedList(tree);
  }, [tree]);

  // 長按拖動排序控制
  const [dragState, setDragState] = useState<DragState | null>(null);
  const holdTimer = useRef<number>(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = dragState;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, mainId: string, index: number) => {
    // 點擊編輯按鈕或展开按鈕時不觸發拖曳長按
    const target = e.target as HTMLElement;
    if (target.closest('.cat-edit-btn') || target.closest('.cat-sub-wrap')) return;

    const startX = e.clientX;
    const startY = e.clientY;

    window.getSelection()?.removeAllRanges();
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      // 計算所有項目高度
      const heights = orderedList.map((t) => cardRefs.current.get(t.main.id)?.offsetHeight ?? 64);
      const state: DragState = {
        activeId: mainId,
        startIndex: index,
        overIndex: index,
        startY,
        currentY: startY,
        itemHeights: heights,
      };
      setDragState(state);
      haptic('medium');
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }, 150);

    const onCancel = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 8 || Math.abs(ev.clientY - startY) > 8) {
        window.clearTimeout(holdTimer.current);
      }
    };
    window.addEventListener('pointermove', onCancel, { once: true });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragRef.current;
    if (!ds) return;
    const dy = e.clientY - ds.startY;

    // 計算目前懸停在第幾個項目（overIndex）
    let cumulative = 0;
    let target = ds.startIndex;
    const centerOffset = dy;

    if (centerOffset > 0) {
      // 往下拖
      for (let i = ds.startIndex + 1; i < orderedList.length; i++) {
        cumulative += ds.itemHeights[i];
        if (centerOffset > cumulative - ds.itemHeights[i] / 2) {
          target = i;
        } else {
          break;
        }
      }
    } else if (centerOffset < 0) {
      // 往上拖
      for (let i = ds.startIndex - 1; i >= 0; i--) {
        cumulative -= ds.itemHeights[i];
        if (centerOffset < cumulative + ds.itemHeights[i] / 2) {
          target = i;
        } else {
          break;
        }
      }
    }

    if (target !== ds.overIndex) {
      haptic('selection');
    }

    setDragState({
      ...ds,
      currentY: e.clientY,
      overIndex: target,
    });
  };

  const onPointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    window.clearTimeout(holdTimer.current);
    const ds = dragRef.current;
    if (!ds) return;

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const { startIndex, overIndex } = ds;
    setDragState(null);

    if (startIndex !== overIndex) {
      haptic('success');
      const next = [...orderedList];
      const [moved] = next.splice(startIndex, 1);
      next.splice(overIndex, 0, moved);
      setOrderedList(next);
      await reorderCategories(next.map((t) => t.main.id));
    }
  };

  return (
    <main className="page categories-page" onContextMenu={(e) => e.preventDefault()}>
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>分類管理</h1>
        <button className="icon-btn" aria-label="新增主分類" onClick={() => setEdit({ parentId: '', kind })}>
          <Icon name="plus" />
        </button>
      </header>

      <Segmented
        value={kind}
        onChange={setKind}
        options={[{ value: 'expense', label: '支出分類' }, { value: 'income', label: '收入分類' }]}
        ariaLabel="分類類型"
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 4px 6px' }}>
        <span className="muted" style={{ fontSize: '0.78rem' }}>長按卡片即可拖曳調整順序</span>
        <button
          type="button"
          className="accent"
          style={{ fontSize: '0.8rem', minHeight: 32 }}
          onClick={() => setShowArchived((s) => !s)}
        >
          {showArchived ? '隱藏封存' : '顯示封存'}
        </button>
      </div>

      <div
        ref={listRef}
        className="cat-manage-list"
        style={{ marginTop: 6 }}
      >
        {orderedList.map(({ main, subs }, index) => {
          const isOpen = expanded === main.id;
          const isDraggingThis = dragState?.activeId === main.id;

          // 計算其他項目的避讓偏移量
          let translateY = 0;
          if (dragState) {
            const { startIndex, overIndex, itemHeights } = dragState;
            const activeH = itemHeights[startIndex] || 64;
            if (isDraggingThis) {
              translateY = dragState.currentY - dragState.startY;
            } else if (startIndex < overIndex && index > startIndex && index <= overIndex) {
              translateY = -activeH - 10;
            } else if (startIndex > overIndex && index >= overIndex && index < startIndex) {
              translateY = activeH + 10;
            }
          }

          return (
            <div
              key={main.id}
              ref={(el) => {
                if (el) cardRefs.current.set(main.id, el);
                else cardRefs.current.delete(main.id);
              }}
              className={`cat-card ${main.archived ? 'archived' : ''}${isDraggingThis ? ' is-dragging' : ''}`}
              style={{
                transform: translateY !== 0 ? `translate3d(0, ${translateY}px, 0)` : undefined,
                transition: isDraggingThis ? 'box-shadow 160ms ease, border-color 160ms ease' : 'transform 200ms cubic-bezier(0.2, 0, 0, 1)',
              }}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => onPointerDown(e, main.id, index)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div className="cat-card-header">
                <button
                  type="button"
                  className="cat-card-main"
                  onClick={() => {
                    if (dragState) return;
                    setExpanded((e) => (e === main.id ? '' : main.id));
                  }}
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

                <button
                  type="button"
                  className="icon-btn plain cat-edit-btn"
                  aria-label={`編輯 ${main.name}`}
                  title="編輯主分類"
                  onClick={() => setEdit({ cat: main, parentId: '', kind })}
                >
                  <Icon name="edit" size={16} />
                </button>

                <div className="cat-card-grip" title="長按拖曳排序" aria-hidden="true">
                  <Icon name="grip" size={16} />
                </div>
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
                      </div>
                    ))}
                    <button
                      type="button"
                      className="cat-chip add"
                      onClick={() => setEdit({ parentId: main.id, kind })}
                    >
                      <Icon name="plus" size={14} />
                      <span>新增子分類</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
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

