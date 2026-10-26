/**
 * 新增／編輯帳戶：名稱、類型、幣別、期初餘額、是否計入淨資產、圖示顏色；
 * 信用卡另有額度、結帳日、繳款日；貸款另有種類、原始本金、年利率、期數、首次還款日（產生攤還表）。
 */
import { useState } from 'react';
import type { Account, AccountType, LoanInfo } from '@/db/types';
import { LOAN_KIND_LABEL } from '@/domain/loan';
import { addMonths, todayKey } from '@/domain/period';
import { ACCOUNT_TYPES, addAccount, deleteOrArchiveAccount, updateAccount } from '@/db/repo/accounts';
import { CURRENCIES, currencyInfo, fromMinor, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { CATEGORY_COLORS } from '@/db/seed/categories';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Sheet } from '@/ui/Sheet';
import { Switch } from '@/ui/controls';

export function AccountSheet({ open, onClose, account }: { open: boolean; onClose: () => void; account?: Account }) {
  return open ? <Inner key={account?.id ?? 'new'} onClose={onClose} account={account} /> : <Sheet open={false} onClose={onClose}>{null}</Sheet>;
}

function Inner({ onClose, account }: { onClose: () => void; account?: Account }) {
  const base = useSettings((s) => s.baseCurrency);
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'bank');
  const [currency, setCurrency] = useState(account?.currency ?? base);
  const [initial, setInitial] = useState(account ? fromMinor(Math.abs(account.initialBalanceMinor), account.currency).toString() : '');
  const [initialNegative, setInitialNegative] = useState(account ? account.initialBalanceMinor < 0 : false);
  const [icon, setIcon] = useState(account?.icon ?? '');
  const [color, setColor] = useState(account?.color ?? CATEGORY_COLORS[6]);
  const [include, setInclude] = useState(account?.includeInNetWorth ?? true);
  const [limit, setLimit] = useState(account?.credit ? fromMinor(account.credit.limitMinor, account.currency).toString() : '');
  const [statementDay, setStatementDay] = useState(account?.credit?.statementDay ?? 20);
  const [dueDay, setDueDay] = useState(account?.credit?.dueDay ?? 5);
  const [note, setNote] = useState(account?.note ?? '');
  const [loanOn, setLoanOn] = useState(!!account?.loan);
  const [loanKind, setLoanKind] = useState<LoanInfo['kind']>(account?.loan?.kind ?? 'mortgage');
  const [loanPrincipal, setLoanPrincipal] = useState(account?.loan ? fromMinor(account.loan.principalMinor, account.currency).toString() : '');
  const [loanApr, setLoanApr] = useState(account?.loan?.aprDec ?? '2.2');
  const [loanTerm, setLoanTerm] = useState(String(account?.loan?.termMonths ?? 360));
  const [loanFirst, setLoanFirst] = useState(account?.loan?.firstPaymentDate ?? addMonths(todayKey(), 1));
  const info = ACCOUNT_TYPES.find((t) => t.type === type)!;
  const isLiability = info.liability;

  const save = async () => {
    if (!name.trim()) { useUI.getState().showSnack({ text: '請輸入帳戶名稱' }); return; }
    const v = evaluate(initial || '0');
    if (!v) { useUI.getState().showSnack({ text: '期初餘額格式錯誤' }); return; }
    // 負債類帳戶：輸入「目前欠款」，以負數儲存
    let initialMinor = toMinor(v, currency);
    if (isLiability || initialNegative) initialMinor = -Math.abs(initialMinor);
    const input = {
      name: name.trim(), type, currency, icon: icon || info.icon, color, includeInNetWorth: include, isLiability,
      initialBalanceMinor: initialMinor, note,
      credit: type === 'credit' ? { limitMinor: toMinor(evaluate(limit || '0') ?? 0, currency), statementDay, dueDay } : undefined,
      loan: type === 'loan' && loanOn ? {
        kind: loanKind, principalMinor: toMinor(evaluate(loanPrincipal || '0') ?? 0, currency), aprDec: loanApr || '0',
        termMonths: Math.max(1, Math.round(Number(loanTerm) || 1)), firstPaymentDate: loanFirst, payFromAccountId: account?.loan?.payFromAccountId,
      } : undefined,
    };
    if (input.loan && input.loan.principalMinor <= 0) { useUI.getState().showSnack({ text: '請輸入原始貸款金額' }); return; }
    try {
      if (account) await updateAccount(account.id, input);
      else await addAccount(input);
      useUI.getState().showSnack({ text: account ? '已更新帳戶' : '已新增帳戶' });
      onClose();
    } catch (e) {
      useUI.getState().showSnack({ text: (e as Error).message });
    }
  };

  const remove = async () => {
    if (!account || !window.confirm(`刪除「${account.name}」？若已有帳目，將改為封存以保留歷史紀錄。`)) return;
    const r = await deleteOrArchiveAccount(account.id);
    useUI.getState().showSnack({ text: r === 'deleted' ? '已刪除帳戶' : '帳戶有帳目，已改為封存' });
    onClose();
  };

  return (
    <Sheet open onClose={onClose} title={account ? '編輯帳戶' : '新增帳戶'} full
      right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={() => void save()}>儲存</button>}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '4px 0 16px' }} role="radiogroup" aria-label="帳戶類型">
        {ACCOUNT_TYPES.map((t) => (
          <button key={t.type} className="pill" role="radio" aria-checked={type === t.type} aria-pressed={type === t.type}
            disabled={!!account && account.type !== t.type && (t.liability !== info.liability)}
            onClick={() => setType(t.type)}>{t.icon} {t.label}</button>
        ))}
      </div>
      <div className="list">
        <div className="field"><label htmlFor="acc-name">名稱</label><input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`例如：${info.label === '信用卡' ? '國泰 CUBE 卡' : info.label === '銀行' ? '台新 Richart' : info.label}`} maxLength={30} /></div>
        <div className="field"><label htmlFor="acc-icon">圖示</label><input id="acc-icon" value={icon} onChange={(e) => setIcon([...e.target.value].slice(-2).join(''))} placeholder={info.icon} /></div>
        <div className="field">
          <label htmlFor="acc-cur">幣別</label>
          <select id="acc-cur" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!!account}>
            {Object.values(CURRENCIES).map((c) => <option key={c.code} value={c.code}>{c.code} {c.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="acc-init">{isLiability ? '目前欠款' : '期初餘額'}</label>
          <input id="acc-init" inputMode="decimal" value={initial} onChange={(e) => setInitial(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" />
          <span className="muted">{currencyInfo(currency).symbol}</span>
        </div>
        {!isLiability && (
          <div className="field"><span className="label" style={{ flex: 1 }}>期初為負數（透支）</span><Switch checked={initialNegative} onChange={setInitialNegative} label="期初為負數" /></div>
        )}
        <div className="field"><span className="label" style={{ flex: 1 }}>計入淨資產</span><Switch checked={include} onChange={setInclude} label="計入淨資產" /></div>
      </div>

      {type === 'credit' && (
        <>
          <div className="section-title">信用卡</div>
          <div className="list">
            <div className="field"><label htmlFor="cc-limit">信用額度</label><input id="cc-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" /></div>
            <div className="field">
              <label htmlFor="cc-st">結帳日</label>
              <select id="cc-st" value={statementDay} onChange={(e) => setStatementDay(Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>每月 {i + 1} 日{i === 30 ? '（月底）' : ''}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cc-due">繳款日</label>
              <select id="cc-due" value={dueDay} onChange={(e) => setDueDay(Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>每月 {i + 1} 日</option>)}
              </select>
            </div>
          </div>
        </>
      )}

      {type === 'loan' && (
        <>
          <div className="section-title">貸款攤還（房貸、車貸…）</div>
          <div className="list">
            <div className="field"><span className="label" style={{ flex: 1 }}>產生攤還表</span><Switch checked={loanOn} onChange={setLoanOn} label="產生攤還表" /></div>
            {loanOn && (
              <>
                <div className="field">
                  <label htmlFor="ln-kind">種類</label>
                  <select id="ln-kind" value={loanKind} onChange={(e) => setLoanKind(e.target.value as LoanInfo['kind'])}>
                    {(Object.keys(LOAN_KIND_LABEL) as LoanInfo['kind'][]).map((k) => <option key={k} value={k}>{LOAN_KIND_LABEL[k]}</option>)}
                  </select>
                </div>
                <div className="field"><label htmlFor="ln-p">原始貸款金額</label><input id="ln-p" inputMode="decimal" value={loanPrincipal} onChange={(e) => setLoanPrincipal(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" /></div>
                <div className="field"><label htmlFor="ln-apr">年利率（%）</label><input id="ln-apr" inputMode="decimal" value={loanApr} onChange={(e) => setLoanApr(e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                <div className="field">
                  <label htmlFor="ln-term">期數（月）</label>
                  <input id="ln-term" inputMode="numeric" value={loanTerm} onChange={(e) => setLoanTerm(e.target.value.replace(/\D/g, ''))} />
                  <span className="muted">{Number(loanTerm) ? `${(Number(loanTerm) / 12).toFixed(1)} 年` : ''}</span>
                </div>
                <div className="field"><label htmlFor="ln-first">第一期還款日</label><input id="ln-first" type="date" value={loanFirst} onChange={(e) => setLoanFirst(e.target.value)} /></div>
              </>
            )}
          </div>
          {loanOn && <p className="muted" style={{ fontSize: '0.8rem', margin: '-4px 8px 12px' }}>「目前欠款」填實際剩餘本金；原始金額與期數用來計算每期應繳與攤還表（本息平均攤還）。</p>}
        </>
      )}

      <div className="section-title">顏色</div>
      <div className="swatches" role="radiogroup" aria-label="顏色">
        {CATEGORY_COLORS.map((c) => (
          <button key={c} className="swatch" style={{ ['--c' as string]: c }} aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} />
        ))}
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        <div className="field"><label htmlFor="acc-note">備註</label><input id="acc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} /></div>
      </div>

      {account && (
        <>
          <button className="btn secondary" style={{ marginBottom: 10 }} onClick={async () => {
            await updateAccount(account.id, { archived: account.archived ? 0 : 1 });
            useUI.getState().showSnack({ text: account.archived ? '已取消封存' : '已封存（不會出現在選單中）' });
            onClose();
          }}>{account.archived ? '取消封存' : '封存帳戶'}</button>
          <button className="btn danger" onClick={() => void remove()}>刪除帳戶</button>
        </>
      )}
    </Sheet>
  );
}
