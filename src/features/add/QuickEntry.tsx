/**
 * 一句話記帳（記帳面板最上方）：打字或說一句話，例如「昨天午餐麥當勞 150 刷玉山卡」。
 * - 解析出一筆：帶入下方的記帳面板，確認後按「完成」
 * - 解析出多筆（「早餐 60 午餐 120」）：列出每一筆，可刪掉不要的，再一次記下
 * 語音：瀏覽器支援語音辨識時顯示麥克風；iPhone 也可以用鍵盤上的聽寫。
 */
import { useEffect, useRef, useState } from 'react';
import type { Account, Category } from '@/db/types';
import { formatMoney, toMinor } from '@/domain/money';
import { shortDate } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { bookDrafts, draftsSmart, type ResolvedDraft } from '@/services/quickentry';
import { deleteTransactions, deleteTransfers } from '@/db/repo/ledger';
import { snackUndo, useUI } from '@/stores/ui';
import { speechRecognition } from '@/services/voice';
import { Icon } from '@/ui/Icon';

const EXAMPLES = ['昨天午餐 150 刷玉山卡', '早餐 60 午餐 120 飲料 55', '計程車兩百三', '領薪水 5萬2'];


export function QuickEntry({ initialText, accMap, catMap, onApply, onBooked }: {
  initialText?: string;
  accMap: Map<string, Account>;
  catMap: Map<string, Category>;
  onApply: (d: ResolvedDraft) => void;
  onBooked: () => void;
}) {
  const [open, setOpen] = useState(!!initialText);
  const [text, setText] = useState(initialText ?? '');
  const [drafts, setDrafts] = useState<ResolvedDraft[]>([]);
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const SR = speechRecognition();
  const today = todayKey();

  const run = async (t = text) => {
    if (!t.trim()) return;
    setBusy(true);
    try {
      const { list, usedAi, aiNote, quotaText } = await draftsSmart(t);
      if (!list.length) { setHint(`找不到金額，試試「午餐 120」或「計程車兩百三」${aiNote ?? ''}`); setDrafts([]); return; }
      setHint('');
      if (list.length === 1) {
        onApply(list[0]);
        setDrafts([]);
        setOpen(false);
        setText('');
        useUI.getState().showSnack({ text: usedAi ? `AI 已協助解析（${quotaText}），確認後按「完成」` : '已帶入，確認後按「完成」' });
      } else setDrafts(list);
    } catch (e) {
      setHint((e as Error).message);
    } finally { setBusy(false); }
  };

  useEffect(() => { if (initialText) void run(initialText); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && !initialText) inputRef.current?.focus(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const listen = () => {
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'zh-TW';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      const said = String(e.results[0][0].transcript ?? '');
      setText(said);
      void run(said);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => { setListening(false); setHint('語音辨識失敗：請允許麥克風，或改用鍵盤上的聽寫'); };
    setListening(true);
    rec.start();
  };

  const bookAll = async () => {
    setBusy(true);
    try {
      const r = await bookDrafts(drafts);
      const total = drafts.length;
      snackUndo(`已記下 ${total} 筆`, async () => {
        if (r.txIds.length) await deleteTransactions(r.txIds);
        if (r.transferIds.length) await deleteTransfers(r.transferIds);
      });
      setDrafts([]);
      setText('');
      onBooked();
    } catch (e) {
      useUI.getState().showSnack({ text: (e as Error).message });
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button className="quick-bar" onClick={() => setOpen(true)} aria-expanded={false}>
        <Icon name="mic" size={18} />
        <span className="row-main">一句話記帳</span>
        <span className="faint quick-bar-eg">「昨天午餐 150 刷玉山卡」</span>
      </button>
    );
  }

  return (
    <div className="quick-panel">
      <div className="quick-input">
        <textarea ref={inputRef} rows={2} value={text} maxLength={300} enterKeyHint="done" aria-label="一句話記帳"
          placeholder="說一句話或打字，例如：昨天午餐麥當勞 150 刷玉山卡"
          onChange={(e) => { setText(e.target.value); setHint(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void run(); } }} />
        <div className="quick-actions">
          {SR && (
            <button className="icon-btn" onClick={listen} aria-label="用說的" aria-pressed={listening}
              style={listening ? { background: 'var(--danger)', color: '#fff' } : undefined}><Icon name="mic" /></button>
          )}
          <button className="btn small" disabled={busy || !text.trim()} onClick={() => void run()}>{busy ? '解析中…' : '帶入'}</button>
        </div>
      </div>
      {hint && <p className="quick-hint" role="status">{hint}</p>}
      {!drafts.length && !hint && (
        <div className="quick-examples" aria-label="範例">
          {EXAMPLES.map((x) => <button key={x} className="pill" onClick={() => { setText(x); void run(x); }}>{x}</button>)}
          <button className="pill" onClick={() => { setOpen(false); setText(''); }}>收起</button>
        </div>
      )}
      {drafts.length > 1 && (
        <>
          <div className="list quick-list">
            {drafts.map((d, i) => {
              const c = d.categoryId ? catMap.get(d.categoryId) : undefined;
              const acc = accMap.get(d.accountId);
              const to = d.toAccountId ? accMap.get(d.toAccountId) : undefined;
              const cur = d.currency ?? acc?.currency ?? 'TWD';
              return (
                <div key={i} className="row with-icon">
                  <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }}>{d.kind === 'transfer' ? '🔁' : c?.icon ?? '✨'}</span>
                  <span className="row-main">
                    <span className="row-title">{d.note || c?.name || (d.kind === 'transfer' ? '轉帳' : '未命名')}</span>
                    <span className="row-sub">{shortDate(d.date, today)} · {d.kind === 'transfer' ? `${acc?.name ?? '?'} → ${to?.name ?? '?'}` : `${c?.name ?? ''} · ${acc?.name ?? ''}`}</span>
                  </span>
                  <span className={`num ${d.kind === 'income' ? 'pos' : d.kind === 'expense' ? 'neg' : ''}`}>{formatMoney(toMinor(d.amount, cur), cur)}</span>
                  <button className="icon-btn plain" aria-label="不要這筆" onClick={() => setDrafts((l) => l.filter((_, j) => j !== i))}><Icon name="close" size={18} /></button>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn secondary" style={{ flex: 1 }} onClick={() => setDrafts([])}>取消</button>
            <button className="btn" style={{ flex: 2 }} disabled={busy} onClick={() => void bookAll()}>全部記下（{drafts.length} 筆）</button>
          </div>
        </>
      )}
    </div>
  );
}
