/**
 * 設定（Tab 5）：外觀、一般（幣別、記帳月起算日、週起始、小數位、千分位）、分類與標籤、
 * 隱私、資料（範例資料、健康檢查、JSON 備份）、關於。
 * 鎖定／通知／股票資料源／完整匯入匯出於後續階段加入。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { clearSampleData, hasSampleData, loadSampleData } from '@/db/seed/sample';
import { CURRENCIES } from '@/domain/money';
import { refreshRates } from '@/services/fx';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import type { AccentKey } from '@/db/repo/settings';
import { Segmented, Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { AUTH_ENABLED, useAuth } from '@/stores/auth';
import { ChangePasswordForm } from '../auth/AuthPages';
import { setEncryption, syncNow, unlockEncryption, useSync } from '@/services/sync';
import { FONT_SIZES } from '@/app/viewport';

const SYNC_TEXT = { off: '未啟用', idle: '已同步', syncing: '同步中…', offline: '離線，恢復連線後自動同步', error: '同步失敗', locked: '需要輸入加密密碼' } as const;

/** 端對端加密：啟用、更換密碼、停用；新裝置輸入密碼解鎖 */
function EncryptionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { phase, e2ee } = useSync();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const snack = (text: string) => useUI.getState().showSnack({ text });
  const locked = phase === 'locked';
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); setPw(''); setPw2(''); } catch (e) { snack((e as Error).message); } finally { setBusy(false); }
  };
  const valid = pw.length >= 8 && pw === pw2;
  return (
    <Sheet open={open} onClose={onClose} title="端對端加密">
      <div className="card" style={{ fontSize: '0.88rem' }}>
        <p style={{ marginTop: 0 }}>{e2ee?.enabled ? '🔒 已啟用：帳目在這台裝置加密後才上傳，伺服器與管理員都無法讀取內容。' : '啟用後，帳目會在裝置上以你設定的「加密密碼」加密後才上傳，伺服器（含 NAS 管理員）只看得到加密後的資料。'}</p>
        <p className="muted" style={{ marginBottom: 0 }}>加密密碼與登入密碼分開，只存在你的腦中與已解鎖的裝置。<b>忘記加密密碼將無法在新裝置取回資料</b>（已登入的裝置仍保有完整資料，可停用後重新上傳）。推播通知的文字不會加密，啟用後推播內容會隱藏金額。</p>
      </div>
      {locked ? (
        <>
          <div className="list">
            <div className="field"><label htmlFor="e2-pw">加密密碼</label><input id="e2-pw" type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          </div>
          <button className="btn" disabled={busy || !pw} onClick={() => void run(async () => {
            if (await unlockEncryption(pw)) { snack('已解鎖，開始同步'); onClose(); } else snack('加密密碼不正確');
          })}>{busy ? '驗證中…' : '解鎖'}</button>
        </>
      ) : (
        <>
          <div className="section-title">{e2ee?.enabled ? '更換加密密碼' : '設定加密密碼'}</div>
          <div className="list">
            <div className="field"><label htmlFor="e2-new">加密密碼</label><input id="e2-new" type="password" autoComplete="new-password" placeholder="至少 8 個字元" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
            <div className="field"><label htmlFor="e2-new2">再輸入一次</label><input id="e2-new2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
          </div>
          {pw2 && pw !== pw2 && <p className="muted" style={{ margin: '0 8px 8px', color: 'var(--danger)' }}>兩次輸入不一致</p>}
          <button className="btn" disabled={busy || !valid} onClick={() => void run(async () => {
            if (!window.confirm(e2ee?.enabled ? '更換後，其他裝置需要輸入新的加密密碼才能繼續同步。確定？' : '啟用後，其他裝置需要輸入這個加密密碼才能同步。確定啟用？')) return;
            await setEncryption(pw);
            snack(e2ee?.enabled ? '已更換加密密碼' : '已啟用端對端加密，資料已重新加密上傳');
            onClose();
          })}>{busy ? '加密並上傳中…' : e2ee?.enabled ? '更換密碼並重新加密' : '啟用端對端加密'}</button>
          {e2ee?.enabled && (
            <button className="btn danger" style={{ marginTop: 8 }} disabled={busy} onClick={() => void run(async () => {
              if (!window.confirm('停用後，資料會以明文重新上傳到伺服器。確定停用？')) return;
              await setEncryption(null);
              snack('已停用端對端加密');
              onClose();
            })}>停用加密</button>
          )}
        </>
      )}
    </Sheet>
  );
}

/** 跨裝置同步狀態：最後同步時間、待上傳筆數、立即同步 */
function SyncRow() {
  const { phase, lastSyncAt, pending, error } = useSync();
  const when = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
  const sub = phase === 'error' ? error : `${SYNC_TEXT[phase]}${phase === 'idle' && when ? `（${when}）` : ''}${pending > 0 && phase !== 'syncing' ? ` · ${pending} 筆待上傳` : ''}`;
  return (
    <button className="row" onClick={() => void syncNow()} disabled={phase === 'syncing'}>
      <span className={`sync-dot ${phase}`} aria-hidden="true" />
      <div className="row-main">
        <div className="row-title">跨裝置同步</div>
        <div className="row-sub">{sub}</div>
      </div>
      <span className="accent" style={{ fontSize: '0.85rem' }}>{phase === 'syncing' ? '' : '立即同步'}</span>
    </button>
  );
}

export const ACCENTS: { key: AccentKey; name: string; color: string }[] = [
  { key: 'cyan', name: '青藍', color: '#22D3EE' },
  { key: 'blue', name: '海藍', color: '#0A84FF' },
  { key: 'indigo', name: '靛紫', color: '#5E5CE6' },
  { key: 'purple', name: '薰衣草', color: '#BF5AF2' },
  { key: 'pink', name: '莓果', color: '#FF375F' },
  { key: 'orange', name: '琥珀', color: '#FF9F0A' },
  { key: 'green', name: '薄荷', color: '#30D158' },
  { key: 'gold', name: '金', color: '#FFD60A' },
];

function Row({ label, children, onClick, sub }: { label: string; children?: React.ReactNode; onClick?: () => void; sub?: string }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className="row" onClick={onClick}>
      <div className="row-main">
        <div className="row-title">{label}</div>
        {sub && <div className="row-sub" style={{ whiteSpace: 'normal' }}>{sub}</div>}
      </div>
      {children}
      {onClick && <Icon name="chevronR" className="row-chev" />}
    </Tag>
  );
}

export default function SettingsPage() {
  const s = useSettings();
  const navigate = useNavigate();
  const sample = useLiveQuery(() => hasSampleData(), []);
  const fxAt = useLiveQuery(async () => (await db.meta.get('fxUpdatedAt'))?.value as number | undefined, []);
  const [busy, setBusy] = useState('');
  const auth = useAuth();
  const [pwOpen, setPwOpen] = useState(false);
  const [encOpen, setEncOpen] = useState(false);
  const syncPhase = useSync((x) => x.phase);
  const syncE2ee = useSync((x) => x.e2ee);
  const snack = (text: string) => useUI.getState().showSnack({ text });

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { snack(`失敗：${(e as Error).message}`); } finally { setBusy(''); }
  };

  return (
    <main className="page">
      <h1 className="large-title" style={{ marginTop: 12 }}>設定</h1>

      {AUTH_ENABLED && auth.user && (
        <>
          <div className="section-title">帳號</div>
          <div className="list">
            <div className="row">
              <span className="cat-icon" aria-hidden="true">{auth.user.username.slice(0, 1).toUpperCase()}</span>
              <div className="row-main">
                <div className="row-title">{auth.user.username}{auth.user.role === 'admin' && <span className="chip" style={{ marginLeft: 6 }}>管理員</span>}</div>
                <div className="row-sub">{auth.user.email}{auth.status === 'offline' ? ' · 離線模式' : ''}</div>
              </div>
            </div>
            <SyncRow />
            <Row label="端對端加密" sub={syncPhase === 'locked' ? '⚠️ 請輸入加密密碼以繼續同步' : syncE2ee?.enabled ? '已啟用：伺服器只保存加密後的資料' : '未啟用：伺服器可讀取帳目內容'} onClick={() => setEncOpen(true)} />
            {auth.user.role === 'admin' && <Row label="資安後台" sub="使用者管理、審計日誌、系統統計" onClick={() => navigate('/admin')} />}
            <Row label="變更密碼" onClick={() => setPwOpen(true)} />
            <button className="row danger" onClick={() => { if (window.confirm('確定登出？帳目已同步到伺服器，在任何裝置重新登入即可繼續使用。')) void auth.logout(); }}>
              <span className="row-main row-title" style={{ color: 'var(--danger)' }}>登出</span>
            </button>
          </div>
          <EncryptionSheet open={encOpen} onClose={() => setEncOpen(false)} />
          <Sheet open={pwOpen} onClose={() => setPwOpen(false)} title="變更密碼">
            {pwOpen && <ChangePasswordForm onDone={() => { setPwOpen(false); useUI.getState().showSnack({ text: '密碼已變更，其他裝置已登出' }); }} />}
          </Sheet>
        </>
      )}

      <div className="section-title">外觀</div>
      <div className="list">
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <Segmented value={s.theme} onChange={(v) => s.set('theme', v)} ariaLabel="深淺色"
            options={[{ value: 'system', label: '跟隨系統' }, { value: 'light', label: '淺色' }, { value: 'dark', label: '深色' }]} />
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="row-title">主題色</div>
          <div className="swatches" role="radiogroup" aria-label="主題色">
            {ACCENTS.map((a) => (
              <button key={a.key} className="swatch" style={{ ['--c' as string]: a.color }} aria-pressed={s.accent === a.key}
                aria-label={a.name} title={a.name} onClick={() => s.set('accent', a.key)} />
            ))}
          </div>
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="row-main">
              <div className="row-title">文字大小</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>{s.fontSize === 'system' ? '跟隨 iPhone「設定 → 螢幕顯示與亮度 → 文字大小」' : '只套用在這台裝置'}</div>
            </div>
            <Switch checked={s.fontSize === 'system'} label="跟隨系統文字大小"
              onChange={(v) => s.set('fontSize', v ? 'system' : FONT_SIZES[1].px)} />
          </div>
          {s.fontSize !== 'system' && (
            <Segmented value={s.fontSize} onChange={(v) => s.set('fontSize', v)} ariaLabel="文字大小"
              options={FONT_SIZES.map((f) => ({ value: f.px, label: f.label }))} />
          )}
          <div className="font-preview" aria-hidden="true">
            <span>午餐・便當</span><span className="num">$120</span>
          </div>
        </div>
        <Row label="收支／漲跌顏色" sub={s.upColor === 'red' ? '紅漲綠跌（台股習慣）：收入與獲利為紅色' : '綠漲紅跌：收入與獲利為綠色'}>
          <div style={{ width: 128, flex: 'none' }}>
            <Segmented value={s.upColor} onChange={(v) => s.set('upColor', v)} ariaLabel="收支顏色"
              options={[{ value: 'red', label: <span style={{ color: 'var(--up-red)' }}>紅漲</span> }, { value: 'green', label: <span style={{ color: 'var(--down-green)' }}>綠漲</span> }]} />
          </div>
        </Row>
      </div>

      <div className="section-title">一般</div>
      <div className="list">
        <div className="field">
          <label htmlFor="s-base">主幣別</label>
          <select id="s-base" value={s.baseCurrency} onChange={(e) => {
            s.set('baseCurrency', e.target.value);
            useUI.getState().showSnack({ text: '已變更主幣別，建議重算舊帳目的換算金額', actionLabel: '前往', onAction: () => navigate('/settings/health'), duration: 6000 });
            void refreshRates(e.target.value).catch(() => undefined);
          }}>
            {Object.values(CURRENCIES).map((c) => <option key={c.code} value={c.code}>{c.code} {c.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="s-msd">記帳月起算</label>
          <select id="s-msd" value={s.monthStartDay} onChange={(e) => s.set('monthStartDay', Number(e.target.value))}>
            {Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>每月 {i + 1} 日</option>)}
            <option value={31}>每月最後一天</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="s-ws">一週起始</label>
          <select id="s-ws" value={s.weekStart} onChange={(e) => s.set('weekStart', Number(e.target.value) as 0 | 1)}>
            <option value={0}>週日</option><option value={1}>週一</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="s-dec">小數位數</label>
          <select id="s-dec" value={String(s.decimals)} onChange={(e) => s.set('decimals', e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as 0 | 1 | 2))}>
            <option value="auto">自動（有零頭才顯示）</option><option value="0">0 位</option><option value="1">1 位</option><option value="2">2 位</option>
          </select>
        </div>
        <div className="field"><span className="label" style={{ flex: 1 }}>千分位</span><Switch checked={s.thousands} onChange={(v) => s.set('thousands', v)} label="千分位" /></div>
        <Row label="幣別與匯率" sub={fxAt ? `上次更新：${new Date(fxAt).toLocaleString('zh-TW')}` : '尚未更新'} onClick={() => navigate('/settings/fx')} />
      </div>

      <div className="section-title">分類與標籤</div>
      <div className="list">
        <Row label="支出／收入分類" sub="兩層分類，自訂名稱、圖示、顏色、排序、封存" onClick={() => navigate('/settings/categories')} />
        <Row label="標籤" onClick={() => navigate('/settings/tags')} />
        <Row label="自動分類規則" sub="依備註、商家自動帶入分類與標籤" onClick={() => navigate('/settings/rules')} />
        <Row label="首頁小工具" sub="今日花費、預算、淨資產、持股損益、近期帳單…" onClick={() => navigate('/settings/widgets')} />
      </div>

      <div className="section-title">投資</div>
      <div className="list">
        <Row label="股票資料源與 API Key" sub="代理網址、資料源順序、手續費折扣、成本法" onClick={() => navigate('/settings/invest')} />
      </div>

      <div className="section-title">隱私與通知</div>
      <div className="list">
        <Row label="隱私與安全" sub={s.lock.enabled ? `App 鎖已啟用${s.lock.webauthn ? '・Face ID' : ''}` : 'PIN 碼、Face ID、隱藏金額'} onClick={() => navigate('/settings/security')} />
        <Row label="通知與提醒" sub="每日記帳、信用卡繳款、預算、訂閱、到價" onClick={() => navigate('/settings/notifications')} />
      </div>

      <div className="section-title">資料</div>
      <div className="list">
        <Row label="備份、匯入與匯出" sub="JSON 完整備份／還原、CSV、Excel、PDF、銀行對帳單與 Moze 匯入" onClick={() => navigate('/settings/backup')} />
        {AUTH_ENABLED && <Row label="自動記帳收件匣" sub="Apple Pay 付款、銀行刷卡簡訊、對 Siri 說一句話，透過 iPhone 捷徑自動記帳" onClick={() => navigate('/inbox')} />}
        <Row label="電子發票" sub="手機條碼載具自動記帳、掃描紙本發票 QR Code、匯入消費明細" onClick={() => navigate('/settings/invoice')} />
        {sample ? (
          <Row label="清除範例資料" sub="只會刪除範例帳戶與帳目，不影響你自己的資料">
            <button className="btn small danger" disabled={busy === 'sample'} onClick={() => run('sample', async () => {
              const n = await clearSampleData();
              snack(`已清除 ${n} 筆範例資料`);
            })}>清除</button>
          </Row>
        ) : (
          <Row label="載入範例資料" sub="90 天的示範帳目，可隨時一鍵清除">
            <button className="btn small tinted" disabled={busy === 'sample'} onClick={() => run('sample', async () => {
              await loadSampleData();
              snack('已載入範例資料');
            })}>{busy === 'sample' ? '載入中…' : '載入'}</button>
          </Row>
        )}
        <Row label="資料健康檢查" sub="帳戶餘額、換算金額、遺失關聯、多餘照片" onClick={() => navigate('/settings/health')} />
        <Row label="清除所有資料" sub="刪除此裝置上的全部資料，無法復原">
          <button className="btn small danger" onClick={async () => {
            if (!window.confirm('確定要刪除所有資料？此動作無法復原。')) return;
            if (window.prompt('請輸入「刪除」以確認') !== '刪除') return;
            await db.delete();
            location.replace('/');
          }}>刪除</button>
        </Row>
      </div>

      <div className="section-title">關於</div>
      <div className="list">
        <Row label="版本" sub={`v${__APP_VERSION__} · 建置於 ${__BUILD_TIME__.slice(0, 10)}`} />
        <Row label="資料隱私" sub="記帳資料存在本機（IndexedDB，每個帳號獨立），並同步到你自己架設的伺服器，讓同一帳號的所有裝置看到相同資料；未啟用端對端加密時，伺服器上的資料為明文。收據照片只留在拍照的裝置。App 鎖 PIN、通知設定不會同步。匯率與股價查詢只會送出幣別／股票代號。" />
        <Row label="重新執行首次引導" onClick={() => { s.set('onboarded', false); navigate('/onboarding'); }} />
      </div>
      <p className="disclaimer">Clure 記帳 · 以 ❤️ 製作於台灣</p>
    </main>
  );
}
