/**
 * 自動分類規則：備註／商家文字 → 分類（可加標籤）。另列出「建議建立的規則」（過去常記在同一分類的文字）。
 * 沒有規則時，記帳也會依過去同樣文字最常用的分類自動帶入（商家記憶）。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { CategoryKind, CategoryRule } from '@/db/types';
import { categoryLabel, useAccounts, useCategories, useTags } from '@/app/hooks';
import { deleteRule, ruleCandidates, saveRule } from '@/services/autocat';
import { ruleMatches } from '@/domain/rules';
import { useUI } from '@/stores/ui';
import { EmptyState, Segmented } from '@/ui/controls';
import { AccountField, CategoryField, SelectField, SwitchField, TextField } from '@/ui/form';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

type Draft = Omit<CategoryRule, 'id' | 'createdAt' | 'updatedAt' | 'hits'> & { id?: string };
const blank = (kind: CategoryKind = 'expense', categoryId = ''): Draft => ({ keyword: '', match: 'contains', kind, categoryId, tagIds: [], priority: 100, enabled: true });
const MATCH_LABEL = { contains: '包含', equals: '完全相同', regex: '正規表示式' } as const;

export default function RulesPage() {
  const navigate = useNavigate();
  const { all: cats, map: catMap } = useCategories();
  const { list: tags } = useTags();
  const { list: accounts, map: accMap } = useAccounts();
  const rules = useLiveQuery(() => db.rules.orderBy('priority').toArray(), []) ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [test, setTest] = useState('');
  const [cands, setCands] = useState<Awaited<ReturnType<typeof ruleCandidates>>>([]);
  useEffect(() => { void ruleCandidates().then(setCands).catch(() => undefined); }, [rules.length]);

  const save = async () => {
    if (!draft) return;
    if (!draft.keyword.trim()) { useUI.getState().showSnack({ text: '請輸入關鍵字' }); return; }
    if (!draft.categoryId) { useUI.getState().showSnack({ text: '請選擇分類' }); return; }
    if (draft.match === 'regex') { try { new RegExp(draft.keyword); } catch { useUI.getState().showSnack({ text: '正規表示式格式錯誤' }); return; } }
    await saveRule({ ...draft, keyword: draft.keyword.trim() });
    setDraft(null);
    useUI.getState().showSnack({ text: '已儲存規則' });
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>自動分類規則</h1>
        <button className="icon-btn" aria-label="新增規則" onClick={() => setDraft(blank())}><Icon name="plus" /></button>
      </header>
      <p className="muted" style={{ margin: '0 8px 12px', fontSize: '0.85rem' }}>
        記帳時輸入的備註、匯入帳單與電子發票的商家名稱符合規則，就自動帶入分類；規則也可以指定帳戶，電子發票會記到該帳戶。沒有規則時，會參考你過去同樣文字最常用的分類與帳戶。
      </p>

      {rules.length === 0 ? (
        <EmptyState emoji="🪄" title="還沒有規則" text="例如：「全聯」→ 日用品、「Uber」→ 交通，可加標籤。" action={<button className="btn small" onClick={() => setDraft(blank())}>新增規則</button>} />
      ) : (
        <div className="list">
          {rules.map((r) => (
            <button key={r.id} className="row" onClick={() => setDraft({ ...r })} style={r.enabled ? undefined : { opacity: 0.5 }}>
              <div className="row-main">
                <div className="row-title">「{r.keyword}」→ {categoryLabel(catMap, r.categoryId)}</div>
                <div className="row-sub">{MATCH_LABEL[r.match]} · {r.kind === 'any' ? '支出與收入' : r.kind === 'expense' ? '支出' : '收入'} · 優先 {r.priority}{r.hits ? ` · 已套用 ${r.hits} 次` : ''}{r.tagIds?.length ? ` · ${r.tagIds.length} 個標籤` : ''}{r.accountId && accMap.get(r.accountId) ? ` · 帳戶：${accMap.get(r.accountId)!.name}` : ''}</div>
              </div>
              <Icon name="chevronR" className="row-chev" />
            </button>
          ))}
        </div>
      )}

      {cands.length > 0 && (
        <>
          <div className="section-title">建議建立的規則</div>
          <div className="list">
            {cands.map((c) => (
              <div key={`${c.kind}|${c.text}`} className="row">
                <div className="row-main">
                  <div className="row-title">「{c.text}」→ {categoryLabel(catMap, c.categoryId)}</div>
                  <div className="row-sub">過去 {c.count} 筆幾乎都記在這個分類</div>
                </div>
                <button className="btn small tinted" onClick={() => void saveRule({ ...blank(c.kind, c.categoryId), keyword: c.text }).then(() => useUI.getState().showSnack({ text: '已建立規則' }))}>建立</button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">測試</div>
      <div className="list">
        <div className="field"><span className="label">輸入文字</span><input value={test} onChange={(e) => setTest(e.target.value)} placeholder="例如：全聯福利中心 信義店" /></div>
        {test.trim() && (
          <div className="row"><span className="row-main row-sub">
            {(() => { const hit = rules.find((r) => ruleMatches(r, test)); return hit ? `符合「${hit.keyword}」→ ${categoryLabel(catMap, hit.categoryId)}` : '沒有符合的規則（會改用商家記憶）'; })()}
          </span></div>
        )}
      </div>

      <Sheet open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? '編輯規則' : '新增規則'}
        right={<button className="accent" onClick={() => void save()}>儲存</button>}>
        {draft && (
          <>
            <div className="list">
              <TextField label="關鍵字" value={draft.keyword} onChange={(v) => setDraft({ ...draft, keyword: v })} placeholder="例如：全聯" maxLength={80} />
              <SelectField label="比對方式" value={draft.match} onChange={(v) => setDraft({ ...draft, match: v })}
                options={(Object.keys(MATCH_LABEL) as Draft['match'][]).map((k) => ({ value: k, label: MATCH_LABEL[k] }))} />
              <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <Segmented value={draft.kind} ariaLabel="適用類型" onChange={(v) => setDraft({ ...draft, kind: v, categoryId: v === 'any' || catMap.get(draft.categoryId)?.kind === v ? draft.categoryId : '' })}
                  options={[{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }, { value: 'any', label: '兩者' }]} />
              </div>
              <CategoryField value={draft.categoryId} onChange={(v) => setDraft({ ...draft, categoryId: v })} categories={cats}
                kind={draft.kind === 'income' ? 'income' : draft.kind === 'expense' ? 'expense' : catMap.get(draft.categoryId)?.kind ?? 'expense'} allowEmpty emptyLabel="請選擇" />
              <AccountField label="指定帳戶" value={draft.accountId ?? ''} onChange={(v) => setDraft({ ...draft, accountId: v || undefined })} accounts={accounts} allowEmpty emptyLabel="不指定" />
              <SelectField label="優先順序" value={draft.priority} onChange={(v) => setDraft({ ...draft, priority: v })}
                options={[{ value: 10, label: '最高' }, { value: 50, label: '高' }, { value: 100, label: '一般' }, { value: 200, label: '低' }]} />
              <SwitchField label="啟用" checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
            </div>
            {tags.length > 0 && (
              <>
                <div className="section-title">同時加上標籤</div>
                <div className="chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 4px 12px' }}>
                  {tags.map((t) => {
                    const on = draft.tagIds?.includes(t.id) ?? false;
                    return <button key={t.id} className="pill" aria-pressed={on} onClick={() => setDraft({ ...draft, tagIds: on ? draft.tagIds!.filter((x) => x !== t.id) : [...(draft.tagIds ?? []), t.id] })}>#{t.name}</button>;
                  })}
                </div>
              </>
            )}
            {draft.id && (
              <button className="btn danger" style={{ width: '100%' }} onClick={async () => {
                if (!window.confirm('刪除這條規則？')) return;
                await deleteRule(draft.id!);
                setDraft(null);
              }}>刪除規則</button>
            )}
          </>
        )}
      </Sheet>
    </main>
  );
}
