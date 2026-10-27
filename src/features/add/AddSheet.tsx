/**
 * 記帳面板（Bottom Sheet）：支出／收入／轉帳／應收／應付／餘額調整。
 * - 自訂計算機鍵盤（四則運算，decimal 精確計算）
 * - 兩層分類、帳戶、日期時間、備註（語音輸入）、標籤、專案、收據照片、外幣與匯率
 * - 再記一筆（連續模式）、常用範本、複製上一筆
 * - 新增與編輯共用；儲存後提供「復原」
 * - 自動分類：輸入備註時依「自動分類規則」與過去的記帳（商家記憶）帶入分類；手動選過分類就不再自動改
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, uid } from '@/db/schema';
import type { Attachment, Template } from '@/db/types';
import {
  addTransaction, addTransfer, deleteTransactions, deleteTransfers, lastTransaction, restoreTransactions, restoreTransfers,
  updateTransaction, updateTransfer,
} from '@/db/repo/ledger';
import { buildTree } from '@/db/repo/categories';
import { evaluate, hasOperator, pressKey } from '@/domain/calc-expr';
import { addThousands, convertMinor, currencyInfo, formatMoney, fromMinor, toMinor } from '@/domain/money';
import { pad2, todayKey } from '@/domain/period';
import { getRate } from '@/services/fx';
import { discardAttachments, saveImageAttachment } from '@/services/attachments';
import { useAccounts, useCategories, useProjects, useTags } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI, type AddMode } from '@/stores/ui';
import { Sheet } from '@/ui/Sheet';
import { Segmented, Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Keypad } from './Keypad';
import { AccountPicker, CurrencyPicker, ProjectPicker, TagPicker } from './pickers';
import { computeSplit, SplitSheet, type SplitState } from './SplitSheet';
import { addDebts, addLoan, findOrCreatePerson, removeLoan } from '@/db/repo/plan';
import { countRuleHit, recentNoteSuggestions, suggestCategory, type CategorySuggestion } from '@/services/autocat';
import type { NoteSuggestion } from '@/domain/notesuggest';
import type { ResolvedDraft } from '@/services/quickentry';
import { QuickEntry } from './QuickEntry';

const MODES: { value: AddMode; label: string }[] = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '轉帳' },
  { value: 'receivable', label: '應收' },
  { value: 'payable', label: '應付' },
  { value: 'adjust', label: '調整' },
];

const isLoanMode = (m: AddMode): m is 'receivable' | 'payable' => m === 'receivable' || m === 'payable';

type Picker = null | 'account' | 'toAccount' | 'currency' | 'tags' | 'project' | 'templates' | 'photo' | 'split';

const nowTime = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

export function AddSheet() {
  const add = useUI((s) => s.add);
  const close = useUI((s) => s.closeAdd);
  return (
    <AddSheetInner key={add.seq} open={add.open} onClose={close}
      prefill={add.prefill} editTxId={add.editTxId} editTransferId={add.editTransferId} />
  );
}

function AddSheetInner({ open, onClose, prefill, editTxId, editTransferId }: {
  open: boolean; onClose: () => void; prefill?: import('@/stores/ui').AddPrefill; editTxId?: string; editTransferId?: string;
}) {
  const settings = useSettings();
  const selectedDate = useUI((s) => s.selectedDate);
  const { list: accounts, map: accMap } = useAccounts();
  const { all: allCats, map: catMap } = useCategories();
  const { list: tags, map: tagMap } = useTags();
  const { list: projects, map: projMap } = useProjects();
  const templates = useLiveQuery(() => db.templates.orderBy('sort').toArray(), []) ?? [];
  const people = useLiveQuery(() => db.people.toArray(), []) ?? [];

  const editing = !!(editTxId || editTransferId);
  const [loaded, setLoaded] = useState(!editing);
  const [mode, setMode] = useState<AddMode>(prefill?.mode ?? 'expense');
  const [expr, setExpr] = useState(prefill?.amount ?? '');
  const [catByKind, setCatByKind] = useState<{ expense: string; income: string }>({ expense: '', income: '' });
  const [mainOpen, setMainOpen] = useState<string>('');
  const [accountId, setAccountId] = useState(prefill?.accountId ?? '');
  const [toAccountId, setToAccountId] = useState(prefill?.toAccountId ?? '');
  const [currency, setCurrency] = useState('');
  const [fxRate, setFxRate] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [fee, setFee] = useState('');
  const [date, setDate] = useState(prefill?.date ?? (selectedDate || todayKey()));
  const [time, setTime] = useState(nowTime());
  const [note, setNote] = useState(prefill?.note ?? '');
  const [tagIds, setTagIds] = useState<string[]>(prefill?.tagIds ?? []);
  const [projectId, setProjectId] = useState(prefill?.projectId ?? '');
  const [atts, setAtts] = useState<{ id: string; url: string; fresh: boolean }[]>([]);
  const [split, setSplit] = useState<SplitState>({ mode: 'equal', people: [] });
  /** 應收／應付：對象、是否同時動到帳戶（借出／借入） */
  const [personName, setPersonName] = useState('');
  const [loanViaAccount, setLoanViaAccount] = useState(true);
  /** 編輯「餘額調整」時記住原本的帳戶與差額，用來還原調整前的基準餘額 */
  const [editAdjust, setEditAdjust] = useState<{ accountId: string; deltaMinor: number } | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  /** 使用者是否已手動選過分類（是的話不再自動分類） */
  const catTouched = useRef(!!prefill?.categoryId);
  const [autoCat, setAutoCat] = useState<(CategorySuggestion & { prev: string }) | null>(null);
  const saved = useRef(false);
  const subRowRef = useRef<HTMLDivElement>(null);

  const kind = mode === 'income' ? 'income' : 'expense';
  const tree = useMemo(() => buildTree(allCats, kind), [allCats, kind]);
  const categoryId = catByKind[kind];
  const account = accMap.get(accountId);
  const toAccount = accMap.get(toAccountId);
  const loan = isLoanMode(mode);
  // 借出／借入直接以帳戶幣別記錄，不做換匯
  const txCurrency = loan && loanViaAccount && account ? account.currency : currency || account?.currency || settings.baseCurrency;
  const exp = currencyInfo(txCurrency).exp;

  // ── 初始值：預設帳戶、深層連結分類、編輯載入 ──
  useEffect(() => {
    if (!accounts.length || accountId) return;
    const last = settings.lastAccountId && accMap.get(settings.lastAccountId) && !accMap.get(settings.lastAccountId)!.archived ? settings.lastAccountId : '';
    setAccountId(last || accounts[0].id);
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!allCats.length || editing) return;
    const resolve = (raw?: string): string => {
      if (!raw) return '';
      if (catMap.has(raw)) return raw;
      for (const p of ['exp-', 'inc-']) if (catMap.has(p + raw)) return p + raw;
      // 同名時（例如每個主分類都有「其他」）優先對應主分類
      return (allCats.find((c) => c.name === raw && !c.parentId) ?? allCats.find((c) => c.name === raw))?.id ?? '';
    };
    const fromPrefill = resolve(prefill?.categoryId);
    const firstOf = (k: 'expense' | 'income') => buildTree(allCats, k)[0]?.main.id ?? '';
    const pk = fromPrefill ? catMap.get(fromPrefill)!.kind : null;
    setCatByKind({
      expense: pk === 'expense' ? fromPrefill : firstOf('expense'),
      income: pk === 'income' ? fromPrefill : firstOf('income'),
    });
    if (pk && !prefill?.mode) setMode(pk);
    setMainOpen(fromPrefill ? catMap.get(fromPrefill)!.parentId || fromPrefill : firstOf(pk ?? (prefill?.mode === 'income' ? 'income' : 'expense')));
  }, [allCats.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editing || !open) return;
    (async () => {
      if (editTxId) {
        const t = await db.transactions.get(editTxId);
        if (!t) { onClose(); return; }
        setMode(t.type === 'transfer_fee' ? 'expense' : t.type);
        setExpr(fromMinor(t.amountMinor, t.currency).toString());
        if (t.type === 'adjust') {
          // 顯示「調整後餘額」：基準餘額（目前餘額 − 這筆差額）＋ 這筆差額 ＝ 目前餘額
          const acc = await db.accounts.get(t.accountId);
          setEditAdjust({ accountId: t.accountId, deltaMinor: t.accountAmountMinor });
          if (acc) setExpr(fromMinor(acc.balanceMinor, acc.currency).toString());
        }
        if (t.type === 'income' || t.type === 'expense') {
          setCatByKind((c) => ({ ...c, [t.type]: t.categoryId }));
          const c = await db.categories.get(t.categoryId);
          setMainOpen(c?.parentId || t.categoryId);
        }
        setAccountId(t.accountId);
        setCurrency(t.currency);
        setFxRate(t.fxRateDec ?? '');
        setDate(t.date);
        const d = new Date(t.ts);
        setTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
        setNote(t.note);
        setTagIds(t.tagIds);
        setProjectId(t.projectId ?? '');
        const rows = await db.attachments.bulkGet(t.attachmentIds);
        setAtts(rows.filter(Boolean).map((r) => ({ id: r!.id, url: URL.createObjectURL(r!.thumb), fresh: false })));
      } else if (editTransferId) {
        const tr = await db.transfers.get(editTransferId);
        if (!tr) { onClose(); return; }
        const from = await db.accounts.get(tr.fromAccountId);
        const to = await db.accounts.get(tr.toAccountId);
        setMode('transfer');
        setAccountId(tr.fromAccountId);
        setToAccountId(tr.toAccountId);
        setExpr(fromMinor(tr.fromAmountMinor, from?.currency ?? 'TWD').toString());
        setToAmount(fromMinor(tr.toAmountMinor, to?.currency ?? 'TWD').toString());
        setFxRate(tr.fxRateDec ?? '');
        setFee(tr.feeMinor ? fromMinor(tr.feeMinor, from?.currency ?? 'TWD').toString() : '');
        setDate(tr.date);
        const d = new Date(tr.ts);
        setTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
        setNote(tr.note);
        setTagIds(tr.tagIds);
        setProjectId(tr.projectId ?? '');
      }
      setLoaded(true);
    })();
  }, [editing, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 外幣：自動帶入匯率（帳目幣別 → 帳戶幣別；或轉帳 轉出帳戶 → 轉入帳戶）
  const rateFrom = mode === 'transfer' ? account?.currency : txCurrency;
  const rateTo = mode === 'transfer' ? toAccount?.currency : account?.currency;
  const needRate = !loan && !!rateFrom && !!rateTo && rateFrom !== rateTo;
  useEffect(() => {
    if (!needRate || !loaded) return;
    if (editing && fxRate) return;
    let alive = true;
    getRate(rateFrom!, rateTo!).then((r) => { if (alive && r) setFxRate(r.toSignificantDigits(8).toString()); });
    return () => { alive = false; };
  }, [rateFrom, rateTo, needRate, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = evaluate(expr);
  const amountMinor = value ? toMinor(value, mode === 'transfer' ? account?.currency ?? txCurrency : txCurrency) : 0;
  const computedToAmount = useMemo(() => {
    if (mode !== 'transfer' || !needRate || !fxRate || !value) return '';
    try { return fromMinor(convertMinor(amountMinor, account!.currency, toAccount!.currency, fxRate), toAccount!.currency).toString(); }
    catch { return ''; }
  }, [mode, needRate, fxRate, amountMinor]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = useCallback((k: string) => setExpr((e) => pressKey(e, k, exp)), [exp, mode]);

  const reset = () => {
    setExpr(''); setNote(''); setAtts([]); setFee(''); setToAmount(''); setPersonName('');
    setTime(nowTime());
  };

  const dirty = !saved.current && (expr !== '' || note !== '' || atts.some((a) => a.fresh));
  const confirmClose = () => !dirty || editing || window.confirm('放棄這筆尚未儲存的記帳？');
  const handleClose = () => {
    if (!saved.current) void discardAttachments(atts.filter((a) => a.fresh).map((a) => a.id));
    onClose();
  };

  /** 餘額調整的基準餘額：編輯同一帳戶時扣回原本的差額 */
  const adjustBaseline = (acc: { id: string; balanceMinor: number }) =>
    acc.balanceMinor - (editAdjust && editAdjust.accountId === acc.id ? editAdjust.deltaMinor : 0);

  // ── 儲存 ──
  const submit = useCallback(async () => {
    if (busy) return;
    if (hasOperator(expr)) { // 先算出結果
      const v = evaluate(expr);
      if (!v) { useUI.getState().showSnack({ text: '運算式有誤' }); return; }
      setExpr(v.toDecimalPlaces(exp).toString());
      return;
    }
    // 空白不可視為 0：餘額調整按「完成」若沒有輸入，會把餘額誤設為 0
    if (!expr.trim() || expr === '-') { useUI.getState().showSnack({ text: mode === 'adjust' ? '請輸入調整後餘額' : '請輸入金額' }); return; }
    const v = evaluate(expr);
    if (!v) { useUI.getState().showSnack({ text: '請輸入金額' }); return; }
    if (!account && !(loan && !loanViaAccount)) { useUI.getState().showSnack({ text: '請先新增帳戶' }); return; }
    if (loan && !personName.trim()) { useUI.getState().showSnack({ text: mode === 'receivable' ? '請輸入欠款人（誰欠你）' : '請輸入債權人（你欠誰）' }); return; }
    if (mode !== 'adjust' && v.lte(0)) { useUI.getState().showSnack({ text: '金額需大於 0' }); return; }
    const ts = new Date(`${date}T${time || '12:00'}:00`).getTime();
    setBusy(true);
    try {
      if (loan) {
        const amt = toMinor(v, txCurrency);
        const res = await addLoan({
          direction: mode === 'receivable' ? 'they_owe_me' : 'i_owe_them', personName: personName.trim(),
          amountMinor: amt, currency: txCurrency, date, ts, note, accountId: loanViaAccount ? account!.id : undefined,
        });
        const who = personName.trim();
        snackUndo(mode === 'receivable' ? `已記下 ${who} 欠你 ${formatMoney(amt, txCurrency)}` : `已記下你欠 ${who} ${formatMoney(amt, txCurrency)}`,
          () => removeLoan(res.debtId));
      } else if (mode === 'transfer') {
        if (!toAccount) { useUI.getState().showSnack({ text: '請選擇轉入帳戶' }); return; }
        if (toAccount.id === account!.id) { useUI.getState().showSnack({ text: '轉出與轉入帳戶不能相同' }); return; }
        const fromMinorAmt = toMinor(v, account!.currency);
        const toStr = needRate ? (toAmount || computedToAmount) : v.toString();
        if (needRate && !toStr) { useUI.getState().showSnack({ text: '請輸入匯率或轉入金額' }); return; }
        const input = {
          fromAccountId: account!.id, toAccountId: toAccount.id, fromAmountMinor: fromMinorAmt,
          toAmountMinor: toMinor(toStr, toAccount.currency), fxRateDec: needRate ? fxRate : undefined,
          feeMinor: fee ? toMinor(evaluate(fee) ?? 0, account!.currency) : 0,
          date, ts, note, tagIds, projectId,
        };
        if (editTransferId) await updateTransfer(editTransferId, input);
        else {
          const tr = await addTransfer(input);
          snackUndo('已新增轉帳', () => deleteTransfers([tr.id]));
        }
      } else {
        const acc = account!;
        let type = mode as 'expense' | 'income' | 'adjust';
        let amt = toMinor(v, txCurrency);
        let catId = categoryId;
        if (mode === 'adjust') {
          catId = 'sys-adjust';
          // 輸入的永遠是「調整後餘額」；差額 = 目標 − 基準（編輯時基準需扣回這筆原本的差額）
          amt = toMinor(v, acc.currency) - adjustBaseline(acc);
          if (amt === 0) { useUI.getState().showSnack({ text: editTxId ? '差額為 0，若不需要這筆調整請直接刪除' : '餘額沒有變化' }); return; }
        } else if (!catId) { useUI.getState().showSnack({ text: '請選擇分類' }); return; }
        const input = {
          type, accountId: acc.id, categoryId: catId, amountMinor: amt,
          currency: mode === 'adjust' ? acc.currency : txCurrency,
          fxRateDec: needRate && mode !== 'adjust' ? fxRate || undefined : undefined,
          date, ts, note, tagIds, projectId, attachmentIds: atts.map((a) => a.id),
          ...(editTxId ? {} : { merchant: prefill?.merchant, invoiceNo: prefill?.invoiceNo }),
        };
        if (autoCat?.ruleId && autoCat.categoryId === catId) void countRuleHit(autoCat.ruleId).catch(() => undefined);
        const sp = mode === 'expense' && !editTxId && split.people.length ? computeSplit(amt, split, txCurrency) : null;
        if (sp?.error) { useUI.getState().showSnack({ text: sp.error }); return; }
        if (editTxId) await updateTransaction(editTxId, input);
        else if (sp && split.payer !== undefined) {
          // 別人先付：不動我的帳戶，只記一筆「我欠先付的人」我的份額；還款時才記為支出（分類沿用這筆的分類）
          if (sp.myShare <= 0) { useUI.getState().showSnack({ text: '你的份額是 0，不用記這筆' }); return; }
          const payer = await findOrCreatePerson(split.payer);
          const debtIds = await addDebts([{
            personId: payer.id, direction: 'i_owe_them', amountMinor: sp.myShare, currency: txCurrency, categoryId: catId,
            groupId: crypto.randomUUID(), date, note: note || catMap.get(catId)?.name || '分帳',
          }]);
          setSplit({ mode: split.mode, people: [] });
          snackUndo(`已記下欠 ${payer.name} ${formatMoney(sp.myShare, txCurrency)}（還款時記為支出）`, async () => { await db.debts.bulkDelete(debtIds); });
        } else {
          const tx = await addTransaction(sp ? { ...input, split: { myShareMinor: sp.myShare, debtIds: [] } } : input);
          if (sp) {
            // 其他人各產生一筆「對方欠我」
            const rows = [];
            for (const sh of sp.shares.filter((x) => x.minor > 0)) {
              const person = await findOrCreatePerson(sh.name);
              rows.push({ personId: person.id, direction: 'they_owe_me' as const, amountMinor: sh.minor, currency: txCurrency, transactionId: tx.id, groupId: tx.id, date, note: note || catMap.get(catId)?.name || '分帳' });
            }
            const debtIds = await addDebts(rows);
            await db.transactions.update(tx.id, { split: { myShareMinor: sp.myShare, debtIds } });
            setSplit({ mode: split.mode, people: [] });
          }
          snackUndo(mode === 'adjust' ? '已調整餘額' : `已記下 ${formatMoney(tx.amountMinor, tx.currency)}${sp ? `（我的份額 ${formatMoney(sp.myShare, tx.currency)}）` : ''}`,
            async () => { await deleteTransactions([tx.id]); if (sp) await db.debts.where('transactionId').equals(tx.id).delete(); });
        }
      }
      if (account) settings.set('lastAccountId', account.id);
      if (prefill?.inboxId && !editing) {
        void import('@/services/inbox').then((m) => m.finishInboxItem(prefill.inboxId!, { card: prefill.inboxCard, accountId: account?.id })).catch(() => undefined);
      }
      if (!editing && settings.continuousAdd && !prefill?.inboxId) {
        // 再記一筆：保留分類／帳戶／日期，清空金額與備註
        atts.forEach((a) => URL.revokeObjectURL(a.url));
        reset();
        navigator.vibrate?.(10);
      } else {
        saved.current = true;
        if (editing) useUI.getState().showSnack({ text: '已更新' });
        onClose();
      }
    } catch (e) {
      useUI.getState().showSnack({ text: `儲存失敗：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }, [busy, expr, exp, account, toAccount, mode, loan, loanViaAccount, personName, date, time, note, tagIds, projectId, atts, categoryId, txCurrency, fxRate, fee, toAmount, computedToAmount, needRate, editTxId, editTransferId, editing, settings, split, catMap, editAdjust]); // eslint-disable-line react-hooks/exhaustive-deps

  // 選取的子分類自動捲到可見位置
  useEffect(() => {
    const row = subRowRef.current;
    const el = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && el) row.scrollTo({ left: el.offsetLeft - row.clientWidth / 2 + el.clientWidth / 2, behavior: 'smooth' });
  }, [categoryId, mainOpen]);

  // ── 自動分類：備註停止輸入 300ms 後查詢 ──
  useEffect(() => {
    if (editing || catTouched.current || (mode !== 'expense' && mode !== 'income')) return;
    const text = note.trim();
    if (text.length < 2) return;
    let alive = true;
    const t = setTimeout(() => {
      void suggestCategory(text, kind).then((sug) => {
        if (!alive || !sug || catTouched.current || !catMap.has(sug.categoryId)) return;
        const c = catMap.get(sug.categoryId)!;
        if (c.kind !== kind) return;
        setCatByKind((cur) => {
          if (cur[kind] !== sug.categoryId) setAutoCat({ ...sug, prev: cur[kind] });
          return { ...cur, [kind]: sug.categoryId };
        });
        setMainOpen(c.parentId || c.id);
        if (sug.tagIds.length) setTagIds((ids) => [...new Set([...ids, ...sug.tagIds.filter((x) => tagMap.has(x))])]);
      }).catch(() => undefined);
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [note, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 最近常記：備註欄下方列出過去同名的備註，點一下帶入金額、分類、帳戶、標籤 ──
  const [noteSugs, setNoteSugs] = useState<NoteSuggestion[]>([]);
  useEffect(() => {
    if (editing || (mode !== 'expense' && mode !== 'income')) { setNoteSugs([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      void recentNoteSuggestions(note, mode, txCurrency).then((r) => { if (alive) setNoteSugs(r); }).catch(() => undefined);
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [note, mode, txCurrency, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const applyNoteSuggestion = (sg: NoteSuggestion) => {
    catTouched.current = true;
    setAutoCat(null);
    const c = catMap.get(sg.categoryId);
    if (c && c.kind === kind && !c.archived) { setCatByKind((cur) => ({ ...cur, [c.kind]: c.id })); setMainOpen(c.parentId || c.id); }
    const acc = accMap.get(sg.accountId);
    if (acc && !acc.archived && acc.currency === txCurrency) setAccountId(acc.id);
    if (!expr) setExpr(fromMinor(sg.amountMinor, sg.currency).toString());
    setNote(sg.note);
    if (sg.tagIds.length) setTagIds((ids) => [...new Set([...ids, ...sg.tagIds.filter((x) => tagMap.has(x))])]);
    navigator.vibrate?.(8);
  };

  // ── 範本、複製上一筆 ──
  const applyTemplate = (t: Template) => {
    catTouched.current = true;
    const p = t.payload;
    if (p.type && p.type !== 'transfer_fee') setMode(p.type);
    if (p.categoryId) {
      const c = catMap.get(p.categoryId);
      if (c) { setCatByKind((s) => ({ ...s, [c.kind]: c.id })); setMainOpen(c.parentId || c.id); }
    }
    if (p.accountId && accMap.has(p.accountId)) setAccountId(p.accountId);
    if (p.amountMinor) setExpr(fromMinor(p.amountMinor, p.currency ?? txCurrency).toString());
    if (p.currency) setCurrency(p.currency);
    if (p.note !== undefined) setNote(p.note);
    if (p.tagIds) setTagIds(p.tagIds);
    void db.templates.update(t.id, { useCount: t.useCount + 1 });
    setPicker(null);
  };
  const saveTemplate = async () => {
    const name = window.prompt('範本名稱', note || catMap.get(categoryId)?.name || '常用');
    if (!name) return;
    const now = Date.now();
    await db.templates.add({
      id: uid(), name, sort: templates.length, useCount: 0, createdAt: now, updatedAt: now,
      payload: {
        type: mode === 'income' ? 'income' : 'expense', categoryId, accountId, currency: txCurrency, note, tagIds,
        amountMinor: value && value.gt(0) ? toMinor(value, txCurrency) : undefined,
      },
    });
    useUI.getState().showSnack({ text: `已存成範本「${name}」` });
  };
  const copyLast = async () => {
    const t = await lastTransaction();
    if (!t) { useUI.getState().showSnack({ text: '還沒有上一筆' }); return; }
    catTouched.current = true;
    setMode(t.type === 'transfer_fee' ? 'expense' : t.type);
    setCatByKind((s) => ({ ...s, [t.type]: t.categoryId }));
    const c = catMap.get(t.categoryId);
    setMainOpen(c?.parentId || t.categoryId);
    setAccountId(t.accountId);
    setCurrency(t.currency);
    setExpr(fromMinor(t.amountMinor, t.currency).toString());
    setNote(t.note);
    setTagIds(t.tagIds);
    setPicker(null);
  };

  // ── 一句話記帳：把解析結果帶入面板 ──
  const applyDraft = (d: ResolvedDraft) => {
    setMode(d.kind);
    setExpr(String(d.amount));
    setDate(d.date);
    if (accMap.has(d.accountId)) setAccountId(d.accountId);
    if (d.kind === 'transfer' && d.toAccountId) setToAccountId(d.toAccountId);
    setCurrency(d.currency && d.currency !== accMap.get(d.accountId)?.currency ? d.currency : '');
    setFxRate('');
    if (d.categoryId && catMap.has(d.categoryId)) {
      const c = catMap.get(d.categoryId)!;
      catTouched.current = true;
      setAutoCat(null);
      setCatByKind((s) => ({ ...s, [c.kind]: c.id }));
      setMainOpen(c.parentId || c.id);
    }
    setNote(d.note);
    if (d.tagIds.length) setTagIds((ids) => [...new Set([...ids, ...d.tagIds.filter((x) => tagMap.has(x))])]);
  };

  // ── 照片 ──
  const onPhoto = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files).slice(0, 4)) {
      try {
        const a: Attachment = await saveImageAttachment(f);
        setAtts((s) => [...s, { id: a.id, url: URL.createObjectURL(a.thumb), fresh: true }]);
      } catch (e) {
        useUI.getState().showSnack({ text: `照片處理失敗：${(e as Error).message}` });
      }
    }
  };
  const openViewer = async (id: string) => {
    const a = await db.attachments.get(id);
    if (a) setViewer(URL.createObjectURL(a.blob));
  };

  // ── 語音輸入備註（Web Speech API；iOS Safari 14.5+ 支援 webkitSpeechRecognition） ──
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const listen = () => {
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'zh-TW';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => setNote((n) => (n ? `${n} ` : '') + e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.onerror = () => { setListening(false); useUI.getState().showSnack({ text: '語音辨識失敗，請確認已允許麥克風' }); };
    setListening(true);
    rec.start();
  };

  // ── 畫面 ──
  const display = (() => {
    if (!expr) return '0';
    const v = evaluate(expr);
    if (!hasOperator(expr) && v) {
      const [i, f] = expr.split('.');
      return addThousands(i) + (f !== undefined ? `.${f}` : '');
    }
    return v ? addThousands(v.toDecimalPlaces(exp).toFixed()) : '—';
  })();
  const amountColor = mode === 'income' ? 'var(--c-pos)' : mode === 'expense' ? 'var(--c-neg)' : 'var(--text)';
  const dateLabel = date === todayKey() ? '今天' : `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
  const selCat = catMap.get(categoryId);
  const mainTree = tree.find((t) => t.main.id === mainOpen);
  const adjustDiff = mode === 'adjust' && account && value ? toMinor(value, account.currency) - adjustBaseline(account) : null;

  const title = editing ? '編輯' : '記一筆';
  const right = !editing && mode !== 'adjust' ? (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem' }} className="muted">
      再記一筆<Switch checked={settings.continuousAdd} onChange={(v) => settings.set('continuousAdd', v)} label="再記一筆模式" />
    </label>
  ) : undefined;

  return (
    <>
      <Sheet open={open} onClose={handleClose} title={title} right={right} full confirmClose={confirmClose}>
        {/* 上半部可捲動、數字鍵盤固定在下方：內容永遠停在鍵盤上緣，不會被鍵盤蓋住 */}
        <div className="add-layout">
          <div className="add-scroll">
          {!editing && (
            <QuickEntry initialText={prefill?.quickText} accMap={accMap} catMap={catMap} onApply={applyDraft}
              onBooked={() => {
                saved.current = true;
                if (prefill?.inboxId) void import('@/services/inbox').then((m) => m.finishInboxItem(prefill.inboxId!, {})).catch(() => undefined);
                onClose();
              }} />
          )}
          {!editTransferId && !(editTxId && mode === 'adjust') && (
            <Segmented value={mode} onChange={(m) => {
              setMode(m);
              if (m === 'adjust') setExpr('');
              if (m === 'expense' || m === 'income') { const c = catMap.get(catByKind[m]); setMainOpen(c?.parentId || c?.id || ''); }
            }}
              options={editing ? MODES.filter((m) => m.value === 'expense' || m.value === 'income') : MODES} ariaLabel="記帳類型" />
          )}

          {/* 金額 */}
          <div className="add-amount">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {mode === 'adjust' ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>調整後餘額</span>
              ) : mode === 'transfer' ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>轉出金額 {account?.currency}</span>
              ) : loan && loanViaAccount ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>{mode === 'receivable' ? '借出金額' : '借入金額'} {txCurrency}</span>
              ) : (
                <button className="cur-btn" onClick={() => setPicker('currency')} aria-label={`幣別 ${txCurrency}`}>{txCurrency} ▾</button>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="expr num" aria-hidden="true">{hasOperator(expr) ? expr : ''}</div>
              <div className="value num" style={{ color: amountColor }} aria-live="polite">
                {currencyInfo(mode === 'transfer' || mode === 'adjust' ? account?.currency ?? txCurrency : txCurrency).symbol}{display}
              </div>
            </div>
          </div>

          {adjustDiff !== null && (
            <p className="muted" style={{ margin: '-6px 4px 8px', fontSize: '0.8rem', textAlign: 'right' }}>
              {editTxId ? '調整前餘額' : '目前餘額'} {formatMoney(adjustBaseline(account!), account!.currency)} → 差額{' '}
              <b className={adjustDiff >= 0 ? 'pos' : 'neg'}>{formatMoney(adjustDiff, account!.currency, { sign: 'always' })}</b>
            </p>
          )}

          {/* 外幣匯率 */}
          {needRate && mode !== 'adjust' && (
            <div className="list" style={{ marginBottom: 8 }}>
              <div className="field">
                <span className="label">匯率</span>
                <span className="muted num" style={{ fontSize: '0.85rem' }}>1 {rateFrom} =</span>
                <input inputMode="decimal" value={fxRate} onChange={(e) => setFxRate(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="匯率" placeholder="取得中…" />
                <span className="muted num">{rateTo}</span>
              </div>
              {mode === 'transfer' ? (
                <div className="field">
                  <span className="label">轉入金額</span>
                  <input inputMode="decimal" value={toAmount || computedToAmount} onChange={(e) => setToAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="轉入金額" />
                  <span className="muted num">{rateTo}</span>
                </div>
              ) : value && fxRate && account ? (
                <div className="field">
                  <span className="label">入帳金額</span>
                  <span className="row-main num" style={{ textAlign: 'right' }}>
                    {(() => { try { return formatMoney(convertMinor(amountMinor, txCurrency, account.currency, fxRate), account.currency); } catch { return '—'; } })()}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {/* 分類 */}
          {(mode === 'expense' || mode === 'income') && (
            <>
              <div className="cat-grid" role="radiogroup" aria-label="分類">
                {tree.map(({ main }) => {
                  const active = selCat ? (selCat.id === main.id || selCat.parentId === main.id) : false;
                  return (
                    <button key={main.id} className="cat-cell" role="radio" aria-checked={active} aria-pressed={active}
                      onClick={() => { catTouched.current = true; setAutoCat(null); setCatByKind((s) => ({ ...s, [kind]: main.id })); setMainOpen(main.id); }}>
                      <span className="cat-icon sm" style={{ ['--c' as string]: main.color }}>{main.icon}</span>
                      {main.name}
                    </button>
                  );
                })}
              </div>
              {mainTree && mainTree.subs.length > 0 && (
                <div className="sub-row" role="radiogroup" aria-label="子分類" ref={subRowRef}>
                  <button className="pill" aria-pressed={categoryId === mainTree.main.id}
                    onClick={() => { catTouched.current = true; setAutoCat(null); setCatByKind((s) => ({ ...s, [kind]: mainTree.main.id })); }}>全部{mainTree.main.name}</button>
                  {mainTree.subs.map((s) => (
                    <button key={s.id} className="pill" aria-pressed={categoryId === s.id}
                      onClick={() => { catTouched.current = true; setAutoCat(null); setCatByKind((c) => ({ ...c, [kind]: s.id })); }}>{s.icon} {s.name}</button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* 應收／應付：對象與是否動到帳戶 */}
          {loan && (
            <div style={{ marginBottom: 8 }}>
              <div className="list" style={{ marginBottom: 8 }}>
                <div className="field">
                  <span className="label">{mode === 'receivable' ? '誰欠你' : '你欠誰'}</span>
                  <input value={personName} onChange={(e) => setPersonName(e.target.value)} placeholder="名字" maxLength={30}
                    aria-label={mode === 'receivable' ? '欠款人' : '債權人'} />
                </div>
                <label className="field" style={{ cursor: 'pointer' }}>
                  <span className="row-main">{mode === 'receivable' ? '從帳戶借出（帳戶扣款）' : '存入帳戶（帳戶入帳）'}</span>
                  <Switch checked={loanViaAccount} onChange={setLoanViaAccount} label={mode === 'receivable' ? '從帳戶借出' : '存入帳戶'} />
                </label>
              </div>
              {people.length > 0 && (
                <div className="sub-row" aria-label="常用對象">
                  {people.map((p) => (
                    <button key={p.id} className="pill" aria-pressed={personName.trim() === p.name} onClick={() => setPersonName(p.name)}>{p.name}</button>
                  ))}
                </div>
              )}
              <p className="muted" style={{ fontSize: '0.75rem', margin: '4px 4px 0' }}>
                {loanViaAccount
                  ? '借出／借入不算支出或收入，不影響收支統計與預算；收回或還款時到「專案 → 應收應付」結清。'
                  : '只記錄欠款、不動帳戶餘額；之後到「專案 → 應收應付」結清時再記入帳戶。'}
              </p>
            </div>
          )}

          {/* 屬性列 */}
          <div className="meta-row">
            {!(loan && !loanViaAccount) && (
              <button className="pill" onClick={() => setPicker('account')}>
                {account ? <>{account.icon} {account.name}</> : '選擇帳戶'}
              </button>
            )}
            {mode === 'transfer' && (
              <>
                <span className="muted" style={{ alignSelf: 'center' }}>→</span>
                <button className="pill" onClick={() => setPicker('toAccount')} aria-pressed={!toAccount}>
                  {toAccount ? <>{toAccount.icon} {toAccount.name}</> : '轉入帳戶'}
                </button>
              </>
            )}
            <span className="pill" style={{ position: 'relative' }}>
              <Icon name="calendar" size={16} /> {dateLabel}
              <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="日期"
                style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%' }} />
            </span>
            <span className="pill num" style={{ position: 'relative' }}>
              <Icon name="clock" size={16} /> {time}
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="時間"
                style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%' }} />
            </span>
            {mode !== 'adjust' && !loan && (
              <>
                <button className="pill" onClick={() => setPicker('tags')} aria-pressed={tagIds.length > 0}>
                  <Icon name="tag" size={16} />{tagIds.length ? tagIds.map((id) => tagMap.get(id)?.name).filter(Boolean).join('、') : '標籤'}
                </button>
                {projects.length > 0 && (
                  <button className="pill" onClick={() => setPicker('project')} aria-pressed={!!projectId}>
                    <Icon name="folder" size={16} />{projMap.get(projectId)?.name ?? '專案'}
                  </button>
                )}
              </>
            )}
            {mode === 'expense' && !editing && (
              <button className="pill" onClick={() => setPicker('split')} aria-pressed={split.people.length > 0}>
                <Icon name="users" size={16} />{split.people.length ? `分帳 ${split.people.length + 1} 人` : '分帳'}
              </button>
            )}
            {mode === 'transfer' && (
              <span className="pill">
                手續費
                <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="0" aria-label="轉帳手續費" style={{ width: 56, border: 0, background: 'transparent', outline: 'none' }} />
              </span>
            )}
            {editing && (
              <button className="pill" style={{ color: 'var(--danger)' }} onClick={() => {
                if (editTxId) void deleteTransactions([editTxId]).then(() => snackUndo('已刪除', () => restoreTransactions([editTxId])));
                if (editTransferId) void deleteTransfers([editTransferId]).then(() => snackUndo('已刪除轉帳', () => restoreTransfers([editTransferId])));
                saved.current = true;
                onClose();
              }}><Icon name="trash" size={16} />刪除</button>
            )}
            {(mode === 'expense' || mode === 'income') && !editing && (
              <>
                <button className="pill" onClick={() => setPicker('templates')}><Icon name="template" size={16} />範本</button>
                <button className="pill" onClick={copyLast}><Icon name="copy" size={16} />上一筆</button>
              </>
            )}
          </div>

          {/* 備註 + 語音 + 照片 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="input" placeholder={mode === 'transfer' ? '備註（例如：提款）' : loan ? '備註（例如：代墊車資）' : '備註、店家…'} value={note}
              onChange={(e) => setNote(e.target.value)} maxLength={200} aria-label="備註"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} />
            {autoCat && catByKind[kind] === autoCat.categoryId && (
              <button className="autocat-chip" role="status"
                aria-label={`已自動分類為「${catMap.get(autoCat.categoryId)?.name}」${autoCat.source === 'rule' ? '（規則）' : '（依過去記帳）'}，點擊還原`}
                title={`依${autoCat.source === 'rule' ? '自動分類規則' : '過去記帳'}選了「${catMap.get(autoCat.categoryId)?.name}」，點擊還原`}
                onClick={() => {
                  catTouched.current = true;
                  setCatByKind((c) => ({ ...c, [kind]: autoCat.prev }));
                  const p = catMap.get(autoCat.prev);
                  if (p) setMainOpen(p.parentId || p.id);
                  setAutoCat(null);
                }}>🪄 自動分類 ✕</button>
            )}
            {SR && (
              <button className="icon-btn" onClick={listen} aria-label="語音輸入備註" aria-pressed={listening}
                style={listening ? { background: 'var(--danger)', color: '#fff' } : undefined}>
                <Icon name="mic" />
              </button>
            )}
            {(mode === 'expense' || mode === 'income') && (
              <label className="icon-btn" aria-label="加入收據照片" style={{ cursor: 'pointer' }}>
                <Icon name="camera" />
                <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => { void onPhoto(e.target.files); e.target.value = ''; }} />
              </label>
            )}
          </div>
          {(() => {
            // 已經選好、且金額也填了的那筆就不必再列出
            const list = noteSugs.filter((x) => !(expr && x.note.toLowerCase() === note.trim().toLowerCase()));
            if (!list.length || (mode !== 'expense' && mode !== 'income') || editing) return null;
            return (
              <div className="sub-row note-sugs" aria-label={note.trim() ? '相似的過去備註' : '最近常記'}>
                {list.map((x) => {
                  const c = catMap.get(x.categoryId);
                  return (
                    <button key={x.note} className="pill" onClick={() => applyNoteSuggestion(x)}
                      aria-label={`${x.note}，${formatMoney(x.amountMinor, x.currency)}，${c?.name ?? ''}`}>
                      <span aria-hidden="true">{c?.icon ?? '🕘'}</span> {x.note} <span className="faint num">{formatMoney(x.amountMinor, x.currency)}</span>
                    </button>
                  );
                })}
              </div>
            );
          })()}
          {atts.length > 0 && (
            <div className="thumbs">
              {atts.map((a) => (
                <div key={a.id} className="thumb">
                  <img src={a.url} alt="收據" onClick={() => void openViewer(a.id)} />
                  <button aria-label="移除照片" onClick={() => setAtts((s) => s.filter((x) => x.id !== a.id))}><Icon name="close" /></button>
                </div>
              ))}
            </div>
          )}

          </div>
          <div className="keypad-dock">
            <Keypad onKey={onKey} onSubmit={() => void submit()} disabled={busy || !loaded}
              submitLabel={hasOperator(expr) ? '=' : editing ? '儲存' : '完成'} />
          </div>
        </div>
      </Sheet>

      <AccountPicker open={picker === 'account'} onClose={() => setPicker(null)} accounts={accounts} value={accountId}
        title={mode === 'transfer' ? '轉出帳戶' : mode === 'receivable' ? '從哪個帳戶借出' : mode === 'payable' ? '存入哪個帳戶' : '選擇帳戶'} onPick={(id) => { setAccountId(id); if (!editing) setFxRate(''); }} />
      <AccountPicker open={picker === 'toAccount'} onClose={() => setPicker(null)} accounts={accounts} value={toAccountId}
        title="轉入帳戶" exclude={accountId} onPick={(id) => { setToAccountId(id); setFxRate(''); setToAmount(''); }} />
      <CurrencyPicker open={picker === 'currency'} onClose={() => setPicker(null)} value={txCurrency} onPick={(c) => { setCurrency(c); setFxRate(''); }} />
      <SplitSheet open={picker === 'split'} onClose={() => setPicker(null)} value={split} onChange={setSplit}
        totalMinor={value && value.gt(0) ? toMinor(value, txCurrency) : 0} currency={txCurrency} />
      <TagPicker open={picker === 'tags'} onClose={() => setPicker(null)} tags={tags} value={tagIds} onChange={setTagIds} />
      <ProjectPicker open={picker === 'project'} onClose={() => setPicker(null)} projects={projects} value={projectId} onPick={setProjectId} />
      <Sheet open={picker === 'templates'} onClose={() => setPicker(null)} title="常用範本">
        {templates.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center' }}>還沒有範本。把常記的項目（早餐、通勤…）存成範本，一鍵帶入。</p>
        ) : (
          <div className="list">
            {[...templates].sort((a, b) => b.useCount - a.useCount).map((t) => {
              const c = t.payload.categoryId ? catMap.get(t.payload.categoryId) : undefined;
              return (
                <div key={t.id} className="row with-icon">
                  <button className="row-main" style={{ display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left' }} onClick={() => applyTemplate(t)}>
                    <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }}>{c?.icon ?? '⭐'}</span>
                    <span>
                      <div className="row-title">{t.name}</div>
                      <div className="row-sub">{c?.name}{t.payload.amountMinor ? ` · ${formatMoney(t.payload.amountMinor, t.payload.currency ?? 'TWD')}` : ''}</div>
                    </span>
                  </button>
                  <button className="icon-btn plain" aria-label={`刪除範本 ${t.name}`} onClick={() => void db.templates.delete(t.id)}><Icon name="trash" size={18} /></button>
                </div>
              );
            })}
          </div>
        )}
        <button className="btn tinted" onClick={() => void saveTemplate()}>將目前內容存為範本</button>
      </Sheet>
      <Sheet open={!!viewer} onClose={() => { if (viewer) URL.revokeObjectURL(viewer); setViewer(null); }} title="收據" full>
        {viewer && <img src={viewer} alt="收據照片" style={{ width: '100%', borderRadius: 12 }} />}
      </Sheet>
    </>
  );
}
