/**
 * 隱私與安全：App 鎖（PIN）、Face ID／Touch ID（WebAuthn）、自動上鎖時間、背景模糊、隱藏金額。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { biometricAvailable, disableLock, registerBiometric, setPin, useLock } from '@/services/lock';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { PinPad } from '@/app/LockScreen';

export default function SecurityPage() {
  const navigate = useNavigate();
  const s = useSettings();
  const [bioOK, setBioOK] = useState(false);
  const [pinStep, setPinStep] = useState<null | 'new' | 'confirm'>(null);
  const [first, setFirst] = useState('');
  useEffect(() => { void biometricAvailable().then(setBioOK); }, []);

  const onPin = async (pin: string) => {
    if (pinStep === 'new') { setFirst(pin); setPinStep('confirm'); return; }
    if (pin !== first) { useUI.getState().showSnack({ text: '兩次輸入不一致，請重新設定' }); setPinStep('new'); return; }
    await setPin(pin);
    setPinStep(null);
    useUI.getState().showSnack({ text: 'App 鎖已啟用' });
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>隱私與安全</h1>
        <div style={{ width: 44 }} />
      </header>
      <div className="section-title">App 鎖</div>
      <div className="list">
        <div className="field"><span className="label" style={{ flex: 1 }}>啟用 PIN 碼鎖定</span>
          <Switch checked={s.lock.enabled} label="App 鎖" onChange={(v) => { if (v) setPinStep('new'); else if (window.confirm('關閉 App 鎖？')) disableLock(); }} />
        </div>
        {s.lock.enabled && (
          <>
            <button className="row" onClick={() => setPinStep('new')}><span className="row-main">變更 PIN 碼</span><Icon name="chevronR" className="row-chev" /></button>
            <div className="field"><span className="label" style={{ flex: 1 }}>Face ID／Touch ID{!bioOK && <span className="row-sub" style={{ display: 'block' }}>此裝置或瀏覽器不支援（需 HTTPS）</span>}</span>
              <Switch checked={!!s.lock.webauthn} label="生物辨識" onChange={async (v) => {
                if (!v) { s.set('lock', { ...s.lock, webauthn: null }); return; }
                try { await registerBiometric(); useUI.getState().showSnack({ text: '已啟用生物辨識解鎖' }); }
                catch (e) { useUI.getState().showSnack({ text: `無法啟用：${(e as Error).message}` }); }
              }} />
            </div>
            <div className="field"><span className="label">自動上鎖</span>
              <select value={s.lock.autoLockSec} onChange={(e) => s.set('lock', { ...s.lock, autoLockSec: Number(e.target.value) })}>
                <option value={0}>立即</option><option value={30}>30 秒後</option><option value={60}>1 分鐘後</option><option value={300}>5 分鐘後</option><option value={900}>15 分鐘後</option>
              </select>
            </div>
            <button className="row accent" onClick={() => useLock.getState().lock()}>立即鎖定</button>
          </>
        )}
      </div>
      <div className="section-title">畫面隱私</div>
      <div className="list">
        <div className="field"><span className="label" style={{ flex: 1 }}>切到背景時模糊畫面</span><Switch checked={s.blurOnHide} onChange={(v) => s.set('blurOnHide', v)} label="背景模糊" /></div>
        <div className="field"><span className="label" style={{ flex: 1 }}>隱藏所有金額</span><Switch checked={s.hideAmounts} onChange={(v) => s.set('hideAmounts', v)} label="隱藏金額" /></div>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', margin: '8px' }}>
        🔒 App 鎖 PIN 只存在這台裝置（不會同步），每台裝置可各自設定。App 鎖保護的是畫面；若裝置本身未上鎖，具備技術能力者仍可能讀取瀏覽器資料。忘記 PIN 時只能清除網站資料（請先備份）。
      </p>
      <Sheet open={!!pinStep} onClose={() => setPinStep(null)} title={pinStep === 'confirm' ? '再輸入一次' : '設定 6 位數 PIN'}>
        {pinStep && <PinPad key={pinStep} onComplete={(p) => void onPin(p)} />}
      </Sheet>
    </main>
  );
}
