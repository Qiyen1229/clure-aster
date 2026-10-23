/**
 * 首次使用引導：歡迎（本機資料聲明）→ 主幣別 → 外觀 → 第一個帳戶 → 範例資料。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addAccount, ACCOUNT_TYPES } from '@/db/repo/accounts';
import { loadSampleData } from '@/db/seed/sample';
import type { AccountType } from '@/db/types';
import { CURRENCIES, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { useSettings } from '@/stores/settings';
import { Segmented } from '@/ui/controls';
import { ACCENTS } from '../settings/SettingsPage';

export default function Onboarding() {
  const s = useSettings();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [accName, setAccName] = useState('錢包');
  const [accType, setAccType] = useState<AccountType>('cash');
  const [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false);
  const STEPS = 5;

  const finish = async (withSample: boolean) => {
    setBusy(true);
    try {
      if (accName.trim()) {
        const info = ACCOUNT_TYPES.find((t) => t.type === accType)!;
        const v = toMinor(evaluate(balance || '0') ?? 0, s.baseCurrency);
        await addAccount({
          name: accName.trim(), type: accType, currency: s.baseCurrency, icon: info.icon, color: '#30D158',
          initialBalanceMinor: info.liability ? -Math.abs(v) : v, includeInNetWorth: true, isLiability: info.liability,
        });
      }
      if (withSample) await loadSampleData();
      s.set('onboarded', true);
      navigate('/', { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const next = () => setStep((x) => Math.min(STEPS - 1, x + 1));

  return (
    <main className="onb">
      <div className="steps" aria-label={`第 ${step + 1} 步，共 ${STEPS} 步`}>
        {Array.from({ length: STEPS }, (_, i) => <i key={i} className={i === step ? 'on' : ''} />)}
      </div>

      {step === 0 && (
        <>
          <img src="/icons/icon-192.png" alt="" width={88} height={88} style={{ borderRadius: 20, marginTop: 24 }} />
          <h1>歡迎使用 Clure 記帳</h1>
          <p>記帳、預算、多帳戶、多幣別、股票投資組合，一個 App 搞定。</p>
          <div className="card">
            <p style={{ margin: 0 }}>🔒 <b>你的資料存在你自己的伺服器</b><br />帳目會自動同步，之後在手機、平板、電腦登入同一個帳號都能看到。這些設定只需要做一次。</p>
          </div>
          <div className="grow" />
          <button className="btn" onClick={next}>開始設定</button>
        </>
      )}

      {step === 1 && (
        <>
          <h1>主要使用的幣別？</h1>
          <p>報表與淨資產會換算成這個幣別。之後可以在設定中更改。</p>
          <div className="list" style={{ maxHeight: '50dvh', overflowY: 'auto' }}>
            {Object.values(CURRENCIES).map((c) => (
              <button key={c.code} className="row" onClick={() => s.set('baseCurrency', c.code)} aria-pressed={s.baseCurrency === c.code}>
                <span className="num" style={{ width: 48, fontWeight: 600 }}>{c.code}</span>
                <span className="row-main">{c.name}</span>
                {s.baseCurrency === c.code && <span className="accent">✓</span>}
              </button>
            ))}
          </div>
          <div className="grow" />
          <button className="btn" onClick={next}>下一步</button>
        </>
      )}

      {step === 2 && (
        <>
          <h1>挑一個喜歡的樣子</h1>
          <p>深色、淺色或跟隨系統，再選一個主題色。</p>
          <Segmented value={s.theme} onChange={(v) => s.set('theme', v)}
            options={[{ value: 'system', label: '跟隨系統' }, { value: 'light', label: '淺色' }, { value: 'dark', label: '深色' }]} />
          <div className="swatches" style={{ marginTop: 16, justifyContent: 'center' }}>
            {ACCENTS.map((a) => (
              <button key={a.key} className="swatch" style={{ ['--c' as string]: a.color, width: 44, height: 44 }} aria-pressed={s.accent === a.key}
                aria-label={a.name} onClick={() => s.set('accent', a.key)} />
            ))}
          </div>
          <p style={{ marginTop: 16 }}>收支顏色</p>
          <Segmented value={s.upColor} onChange={(v) => s.set('upColor', v)}
            options={[{ value: 'red', label: '紅漲綠跌（台股）' }, { value: 'green', label: '綠漲紅跌' }]} />
          <div className="grow" />
          <button className="btn" onClick={next}>下一步</button>
        </>
      )}

      {step === 3 && (
        <>
          <h1>建立第一個帳戶</h1>
          <p>記帳時要選擇從哪個帳戶付款，先建一個最常用的吧。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {ACCOUNT_TYPES.filter((t) => ['cash', 'bank', 'epay', 'credit'].includes(t.type)).map((t) => (
              <button key={t.type} className="pill" aria-pressed={accType === t.type}
                onClick={() => { setAccType(t.type); setAccName(t.type === 'cash' ? '錢包' : t.label); }}>{t.icon} {t.label}</button>
            ))}
          </div>
          <div className="list">
            <div className="field"><label htmlFor="o-name">名稱</label><input id="o-name" value={accName} onChange={(e) => setAccName(e.target.value)} /></div>
            <div className="field">
              <label htmlFor="o-bal">{accType === 'credit' ? '目前欠款' : '目前餘額'}</label>
              <input id="o-bal" inputMode="decimal" value={balance} placeholder="0" onChange={(e) => setBalance(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
          </div>
          <div className="grow" />
          <button className="btn" onClick={next} disabled={!accName.trim()}>下一步</button>
          <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => { setAccName(''); next(); }}>略過</button>
        </>
      )}

      {step === 4 && (
        <>
          <h1>要先看看範例嗎？</h1>
          <p>載入 90 天的示範帳目，快速體驗月曆、列表與報表。範例資料可在「設定 → 資料」一鍵清除，不影響你自己的帳。</p>
          <div className="grow" />
          <button className="btn" disabled={busy} onClick={() => void finish(true)}>{busy ? '準備中…' : '載入範例資料'}</button>
          <button className="btn secondary" style={{ marginTop: 8 }} disabled={busy} onClick={() => void finish(false)}>從空白開始</button>
        </>
      )}

      {step > 0 && !busy && (
        <button className="muted" style={{ marginTop: 12, minHeight: 44 }} onClick={() => setStep((x) => x - 1)}>上一步</button>
      )}
    </main>
  );
}
