/**
 * 首次使用引導（4 步）：歡迎與主幣別 → 外觀 → 第一個帳戶 → 範例資料。
 * 功能介紹不放在這裡：新功能由設定裡的「新」標記與更新通知帶出（release.json）。
 */
import { ICON_192 } from '@/ui/assets';
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
  const STEPS = 4;

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
          <img src={ICON_192} alt="" width={72} height={72} style={{ borderRadius: 16, marginTop: 8 }} />
          <h1>歡迎使用 Aster 記帳</h1>
          <p style={{ marginBottom: 8 }}>🔒 你的資料存在你自己的伺服器，帳目會自動同步到你登入的每台裝置。先選主要使用的幣別（報表與淨資產會換算成它，之後可在設定更改）。</p>
          <div className="list" style={{ maxHeight: '44dvh', overflowY: 'auto' }}>
            {Object.values(CURRENCIES).map((c) => (
              <button key={c.code} className="row" onClick={() => s.set('baseCurrency', c.code)} aria-pressed={s.baseCurrency === c.code}>
                <span className="num" style={{ width: 48, fontWeight: 600 }}>{c.code}</span>
                <span className="row-main">{c.name}</span>
                {s.baseCurrency === c.code && <span className="accent">✓</span>}
              </button>
            ))}
          </div>
          <div className="grow" />
          <button className="btn" onClick={next}>開始設定</button>
        </>
      )}

      {step === 1 && (
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

      {step === 2 && (
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

      {step === 3 && (
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
