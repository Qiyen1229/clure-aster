/**
 * 設定（Tab 5）：
 * 整合為 4 大主題集中入口：記帳與分類、自動化與智慧、介面與通知、系統與資料。
 * 主頁面俐落清爽、一目瞭然；性質相近的功能合併於專屬面板內。
 */
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { clearSampleData, hasSampleData, loadSampleData } from '@/db/seed/sample';
import { CURRENCIES } from '@/domain/money';
import { checkForUpdate } from '@/services/appUpdate';
import { refreshRates } from '@/services/fx';
import { haptic } from '@/services/haptics';
import { useSettings } from '@/stores/settings';
import { useUI, ask, askInput } from '@/stores/ui';
import type { AccentKey } from '@/db/repo/settings';
import { Segmented, Switch } from '@/ui/controls';
import { Icon, type IconName } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { InfoModal } from '@/ui/Hint';
import { NewMark } from '@/ui/NewMark';
import { openWhatsNew } from '@/features/whatsnew/WhatsNew';
import { AUTH_ENABLED, useAuth } from '@/stores/auth';
import { ChangePasswordForm } from '../auth/AuthPages';
import { setEncryption, syncNow, unlockEncryption, useSync } from '@/services/sync';
import { FONT_SIZES } from '@/app/viewport';
import { api } from '@/services/api';
import { confirmIdentity } from '@/services/identity';
import { wipeLocalData } from '@/services/lockGuard';

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
        <p style={{ marginTop: 0 }}>{e2ee?.enabled ? '🔒 已啟用：帳目在這台裝置加密後才上傳，伺服器與管理員都讀不到。' : '啟用後，帳目會用你的「加密密碼」在裝置上加密才上傳，伺服器（含管理員）只看得到密文。'}</p>
        <p className="muted" style={{ marginBottom: 0 }}>加密密碼與登入密碼分開。<b>忘記加密密碼，新裝置就取不回資料</b>（已登入的裝置仍有完整資料，可停用後重新上傳）。啟用後，推播內容會隱藏金額。</p>
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
            if (!await ask(e2ee?.enabled ? '更換後，其他裝置需要輸入新的加密密碼才能繼續同步。確定？' : '啟用後，其他裝置需要輸入這個加密密碼才能同步。確定啟用？')) return;
            await setEncryption(pw);
            snack(e2ee?.enabled ? '已更換加密密碼' : '已啟用端對端加密，資料已重新加密上傳');
            onClose();
          })}>{busy ? '加密並上傳中…' : e2ee?.enabled ? '更換密碼並重新加密' : '啟用端對端加密'}</button>
          {e2ee?.enabled && (
            <button className="btn danger" style={{ marginTop: 8 }} disabled={busy} onClick={() => void run(async () => {
              if (!await ask('停用後，資料會以明文重新上傳到伺服器。確定停用？')) return;
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
  const { phase, lastSyncAt, pending, error, oversizedItems } = useSync();
  const when = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
  const oversizedText = oversizedItems?.length ? ` · ${oversizedItems.length} 筆過大已略過` : '';
  const sub = phase === 'error' ? error : `${SYNC_TEXT[phase]}${phase === 'idle' && when ? `（${when}）` : ''}${pending > 0 && phase !== 'syncing' ? ` · ${pending} 筆待上傳` : ''}${oversizedText}`;
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

/** 設定列：左側色塊圖示 + 標題 (+ ⓘ 浮窗) + 右側狀態/控制項 */
function Row({ label, children, onClick, sub, hint, icon, tint, danger, newSince }: {
  label: string; children?: React.ReactNode; onClick?: () => void; sub?: string; hint?: React.ReactNode; icon?: IconName; tint?: string; danger?: boolean; newSince?: string;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const Tag = onClick ? 'button' : 'div';
  return (
    <>
      <Tag className={`row${icon ? ' with-icon' : ''}`} onClick={onClick}>
        {icon && <span className="set-tile" style={tint ? { ['--c' as string]: tint } : undefined} aria-hidden="true"><Icon name={icon} size={18} /></span>}
        <div className="row-main">
          <div className="row-title" style={danger ? { color: 'var(--danger)' } : undefined}>
            {newSince && <NewMark since={newSince} className="new-before" />}
            <span>{label}</span>
            {hint && (
              <button
                type="button"
                className="hint-btn"
                aria-label={`${label}說明`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setInfoOpen(true);
                }}
              >
                <Icon name="info" />
              </button>
            )}
          </div>
          {sub && <div className="row-sub" style={{ whiteSpace: 'normal' }}>{sub}</div>}
        </div>
        {children}
        {onClick && !danger && <Icon name="chevronR" className="row-chev" />}
      </Tag>
      {infoOpen && hint && <InfoModal title={label} content={hint} onClose={() => setInfoOpen(false)} />}
    </>
  );
}

function Group({ id, title, children }: { id?: string; title?: string; children: React.ReactNode }) {
  return (
    <section className="set-group" id={id}>
      {title && <div className="section-title">{title}</div>}
      <div className="list">{children}</div>
    </section>
  );
}

/** 面板內跳轉子頁面：先關閉抽屜並給予 120ms 離場，避免跳頁快照殘留導致返回時抽屜卡頓停留 */
function useHubNav(onClose: () => void) {
  const navigate = useNavigate();
  return (to: string) => {
    onClose();
    window.setTimeout(() => navigate(to), 120);
  };
}

/** 外觀與首頁版面：深淺色、主題色、文字大小、收支顏色、首頁快覽配置 */
function AppearanceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings();
  const navTo = useHubNav(onClose);
  return (
    <Sheet open={open} onClose={onClose} title="外觀與首頁版面">
      <div className="list">
        <div className="row set-stack">
          <Segmented value={s.theme} onChange={(v) => s.set('theme', v)} ariaLabel="深淺色"
            options={[{ value: 'system', label: '跟隨系統' }, { value: 'light', label: '淺色' }, { value: 'dark', label: '深色' }]} />
        </div>
        <div className="row set-stack">
          <div className="row-title">主題色</div>
          <div className="swatches" role="radiogroup" aria-label="主題色">
            {ACCENTS.map((a) => (
              <button key={a.key} className="swatch" style={{ ['--c' as string]: a.color }} aria-pressed={s.accent === a.key}
                aria-label={a.name} title={a.name} onClick={() => s.set('accent', a.key)} />
            ))}
          </div>
        </div>
        <div className="row set-stack">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="row-main">
              <div className="row-title">文字大小</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>{s.fontSize === 'system' ? '跟隨 iPhone 的文字大小設定' : '只套用在這台裝置'}</div>
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
        <Row label="收支／漲跌顏色" hint="自訂支出與虧損顏色。預設為支出紅、收入綠；台股投資習慣可切換為支出綠、收入紅。">
          <div style={{ width: 128, flex: 'none' }}>
            <Segmented value={s.upColor} onChange={(v) => s.set('upColor', v)} ariaLabel="收支顏色"
              options={[{ value: 'green', label: <span style={{ color: 'var(--up-red)' }}>支紅</span> }, { value: 'red', label: <span style={{ color: 'var(--down-green)' }}>支綠</span> }]} />
          </div>
        </Row>
        <Row icon="grip" tint="#FF9F0A" label="首頁快覽配置" hint="自由勾選並拖曳排序首頁出現的快覽卡片，包括資產概覽、本月收支、心願清單等。" onClick={() => navTo('/settings/widgets')} />
      </div>
    </Sheet>
  );
}

/** 記帳格式與幣別：主幣別、記帳月起算、一週起始、小數位數、千分位、匯率更新 */
function PrefsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings();
  const navigate = useNavigate();
  const navTo = useHubNav(onClose);
  const fxAt = useLiveQuery(async () => (await db.meta.get('fxUpdatedAt'))?.value as number | undefined, []);
  return (
    <Sheet open={open} onClose={onClose} title="記帳格式與幣別">
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
        <div className="field"><span className="label" style={{ flex: 1 }}>千分位逗號</span><Switch checked={s.thousands} onChange={(v) => s.set('thousands', v)} label="千分位" /></div>
        <Row icon="globe" tint="#0A84FF" label="幣別與即時匯率" hint="查看各國貨幣即時匯率與手動更新，由伺服器向各大國際金融機構取得。" onClick={() => navTo('/settings/fx')}
          sub={fxAt ? `上次更新 ${new Date(fxAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : undefined} />
      </div>
    </Sheet>
  );
}

/** 分類、標籤與規則集合面板 */
function TaxonomyHubSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navTo = useHubNav(onClose);
  return (
    <Sheet open={open} onClose={onClose} title="分類、標籤與規則">
      <div className="list">
        <Row icon="tags" tint="#FF375F" label="支出／收入分類" onClick={() => navTo('/settings/categories')} />
        <Row icon="tag" tint="#BF5AF2" label="標籤管理" hint="跨分類的獨立標記維度（如：出差、出國、公費、家庭分攤），方便跨類別交叉統計。" onClick={() => navTo('/settings/tags')} />
        <Row icon="filter" tint="#30B0C7" label="自動分類規則" hint="依消費備註關鍵字或商家名稱，在記帳或匯入時自動帶入指定分類與標籤。" onClick={() => navTo('/settings/rules')} />
        <Row icon="pin" tint="#FF9F0A" label="常用項目（釘選）" hint="將經常重複消費的項目釘選在記帳面板的建議列，點擊一鍵快速帶入。" onClick={() => navTo('/settings/pinned')} />
      </div>
    </Sheet>
  );
}

/** 自動記帳與對帳集合面板 */
function AutoRecordHubSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navTo = useHubNav(onClose);
  return (
    <Sheet open={open} onClose={onClose} title="自動記帳與對帳">
      <div className="list">
        <Row icon="inbox" tint="#30D158" label="自動記帳收件匣" hint="透過 iPhone 捷徑接收台灣 52 家銀行 App、LINE Pay、街口通知與 Apple Pay 刷卡交易，暫存於收件匣一鍵入帳。" onClick={() => navTo('/inbox')} />
        <Row icon="receipt" tint="#0A84FF" label="電子發票載具" hint="綁定財政部手機條碼載具，自動同步發票明細、自動對獎並一鍵匯入記帳。" onClick={() => navTo('/settings/invoice')} />
        <Row icon="check" tint="#FF9F0A" label="帳單對帳匯入" hint="匯入網銀信用卡 CSV 對帳單，比對現有帳本紀錄，快速抓出漏記或重複扣款。" onClick={() => navTo('/settings/import?mode=reconcile')} />
      </div>
    </Sheet>
  );
}

/** AI 助理與智慧偵測集合面板 */
function AiHubSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navTo = useHubNav(onClose);
  return (
    <Sheet open={open} onClose={onClose} title="AI 助理與智慧偵測">
      <div className="list">
        {AUTH_ENABLED && (
          <Row icon="slidersHorizontal" tint="#8E8E93" label="AI 功能設定與額度" hint="管理 AI 助理總開關、送出內容去識別化隱私防護，以及查詢剩餘額度點數。" onClick={() => navTo('/settings/ai')} />
        )}
        <Row icon="ai" tint="#17181c" label="消費異常與預算預警" hint="由本機純離線規則自動偵測重複扣款、訂閱突然漲價、大額支出與各分類預算超支警示。" onClick={() => navTo('/ai')} />
      </div>
    </Sheet>
  );
}

/** 帳號安全與隱私集合面板 */
function SecurityHubSheet({ open, onClose, onOpenEnc, onOpenPw }: { open: boolean; onClose: () => void; onOpenEnc: () => void; onOpenPw: () => void }) {
  const s = useSettings();
  const auth = useAuth();
  const navTo = useHubNav(onClose);
  const syncPhase = useSync((x) => x.phase);
  const syncE2ee = useSync((x) => x.e2ee);
  return (
    <Sheet open={open} onClose={onClose} title="帳號安全與隱私">
      <div className="list">
        <Row icon="shieldCheck" tint="#5E5CE6" label="端對端加密" hint="資料在你的裝置加密後才同步至伺服器。即使伺服器或資料庫遭竊，任何人都無法解密你的帳目。" onClick={() => { onClose(); onOpenEnc(); }}>
          <span className="row-value muted" style={{ fontSize: '0.85rem' }}>{syncPhase === 'locked' ? '⚠️ 需要解鎖' : syncE2ee?.enabled ? '已啟用' : '未啟用'}</span>
        </Row>
        <Row icon="lock" tint="#30B0C7" label="App 鎖與隱私" hint="設定 4 位數 PIN 碼、啟用 Face ID / Touch ID 生物辨識解鎖，以及在多工切換時自動模糊隱藏金額。" onClick={() => navTo('/settings/security')}>
          <span className="row-value muted" style={{ fontSize: '0.85rem' }}>{s.lock.enabled ? '已啟用' : '未啟用'}</span>
        </Row>
        <Row icon="edit" tint="#8E8E93" label="變更登入密碼" onClick={() => { onClose(); onOpenPw(); }} />
        {auth.user?.role === 'admin' && (
          <Row icon="users" tint="#FF9F0A" label="資安後台" hint="管理使用者帳號、開放註冊開關、審計日誌與系統診斷工具（僅管理員可見）。" onClick={() => navTo('/admin')} />
        )}
      </div>
    </Sheet>
  );
}

/** 資料備份與維護集合面板 */
function DataHubSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navTo = useHubNav(onClose);
  const sample = useLiveQuery(() => hasSampleData(), []);
  const [busy, setBusy] = useState('');
  const snack = (text: string) => useUI.getState().showSnack({ text });
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { snack(`失敗：${(e as Error).message}`); } finally { setBusy(''); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="資料備份與維護">
      <div className="list">
        <Row icon="database" tint="#0A84FF" label="備份、匯入與匯出" hint="支援本機完整備份還原（含 AES-256 加密）、匯出 CSV、Excel、PDF 報表與他家記帳軟體資料匯入。" onClick={() => navTo('/settings/backup')} />
        <Row icon="check" tint="#30D158" label="資料健康檢查" hint="掃描本機 IndexedDB 與伺服器資料庫，自動修復帳目關聯、餘額快取不一致與損壞索引。" onClick={() => navTo('/settings/health')} />
        {sample ? (
          <Row icon="sparkles" tint="#8E8E93" label="清除範例資料" hint="移除系統預先建立的 90 天展示用範例帳戶與帳目。">
            <button className="btn small danger" disabled={busy === 'sample'} onClick={() => run('sample', async () => {
              const n = await clearSampleData();
              snack(`已清除 ${n} 筆範例資料`);
            })}>清除</button>
          </Row>
        ) : (
          <Row icon="sparkles" tint="#8E8E93" label="載入示範資料" hint="建立 90 天完整的擬真生活帳目與帳戶，可隨時一鍵清除。">
            <button className="btn small tinted" disabled={busy === 'sample'} onClick={() => run('sample', async () => {
              await loadSampleData();
              snack('已載入示範資料');
            })}>{busy === 'sample' ? '載入中…' : '載入'}</button>
          </Row>
        )}
      </div>
    </Sheet>
  );
}

/** 關於 Aster 集合面板 */
function AboutHubSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings();
  const navTo = useHubNav(onClose);
  const [checking, setChecking] = useState(false);
  const snack = (text: string) => useUI.getState().showSnack({ text });
  return (
    <Sheet open={open} onClose={onClose} title="關於 Aster">
      <div className="list">
        <Row icon="info" tint="#8E8E93" label="版本" hint={`當前版本 v${__APP_VERSION__}，建置於 ${__BUILD_TIME__.slice(0, 10)}。Aster 採用漸進式 PWA 與離線資料庫架構。`}>
          <span className="row-value muted" style={{ fontSize: '0.85rem', marginRight: 8 }}>v{__APP_VERSION__}</span>
          <button className="pill" disabled={checking} onClick={async () => {
            setChecking(true);
            try {
              const r = await checkForUpdate();
              if (r === 'reloading') snack('找到新版本，正在更新…');
              else if (r === 'latest') snack('已經是最新版本 ✓');
              else location.reload();
            } catch { snack('無法連線到伺服器，請稍後再試'); } finally { setChecking(false); }
          }}>{checking ? '檢查中…' : '檢查更新'}</button>
        </Row>
        <Row icon="sparkles" tint="#0A84FF" label="版本更新重點" onClick={() => { onClose(); openWhatsNew(); }} />
        <Row icon="compass" tint="#FF9F0A" label="重新執行首次引導" onClick={() => { s.set('onboarded', false); navTo('/onboarding'); }} />
        <Row icon="lock" tint="#30B0C7" label="隱私權政策" onClick={() => navTo('/privacy')} />
        <Row icon="note" tint="#8E8E93" label="服務條款與授權" onClick={() => navTo('/terms')} />
        <details className="set-details" style={{ margin: '8px 4px 4px' }}>
          <summary>資料隱私與開源授權說明</summary>
          <p>記帳資料存在本機，並同步到你的伺服器，各裝置看到同一份；未啟用端對端加密時，伺服器上是明文。收據照片只留在拍照的裝置，App 鎖 PIN 與通知設定不同步。匯率與股價查詢只送出幣別或股票代號。</p>
          <p style={{ marginTop: 6 }}>圖示集源自 Lucide Icons，採 ISC 開源授權（相容 MIT、可商用）。</p>
        </details>
      </div>
    </Sheet>
  );
}

/** 通知與市場整合集合面板 */
function IntegrationHubSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navTo = useHubNav(onClose);
  return (
    <Sheet open={open} onClose={onClose} title="通知與市場整合">
      <div className="list">
        <Row icon="bell" tint="#FF3B30" label="通知與提醒中心" hint="設定每日定時記帳提醒、信用卡繳款日通知、預算超支即時推播與股票到價警示。" onClick={() => navTo('/settings/notifications')} />
        <Row icon="trend" tint="#5E5CE6" label="股票行情資料源與 API Key" hint="設定台股與美股即時報價來源（Yahoo Finance、FinMind、AlphaVantage）以及證券券商手續費折數。" onClick={() => navTo('/settings/invest')} />
      </div>
    </Sheet>
  );
}

const PTR_THRESHOLD = 58;

export default function SettingsPage() {
  const s = useSettings();
  const auth = useAuth();
  const [pwOpen, setPwOpen] = useState(false);
  const [encOpen, setEncOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [secOpen, setSecOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [integOpen, setIntegOpen] = useState(false);

  // 下拉刷新（Pull-to-Refresh）：硬體加速、零重繪
  const [armed, setArmed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const ptrRef = useRef<{
    startY: number;
    startX: number;
    active: boolean;
    armed: boolean;
    currentY: number;
    rafId: number;
  } | null>(null);

  const onTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (refreshing || window.scrollY > 2) return;
    const t = e.touches[0];
    if (!t) return;
    ptrRef.current = { startY: t.clientY, startX: t.clientX, active: false, armed: false, currentY: 0, rafId: 0 };
  };
  const onTouchMove = (e: React.TouchEvent<HTMLElement>) => {
    const st = ptrRef.current;
    if (!st || refreshing) return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - st.startY;
    const dx = Math.abs(t.clientX - st.startX);
    if (!st.active) {
      if (dy < 8 || dx > dy || window.scrollY > 2) {
        if (dx > 14 || dy < -4) ptrRef.current = null;
        return;
      }
      st.active = true;
      if (indicatorRef.current) indicatorRef.current.style.transition = 'none';
    }
    const damped = Math.max(0, Math.min(78, Math.pow(Math.max(0, dy - 8), 0.76) * 2.2));
    st.currentY = damped;

    if (damped >= PTR_THRESHOLD && !st.armed) {
      st.armed = true;
      setArmed(true);
      haptic('medium');
    } else if (damped < PTR_THRESHOLD && st.armed) {
      st.armed = false;
      setArmed(false);
      haptic('selection');
    }

    if (!st.rafId) {
      st.rafId = requestAnimationFrame(() => {
        if (ptrRef.current) {
          ptrRef.current.rafId = 0;
          const el = indicatorRef.current;
          if (el) {
            const y = ptrRef.current.currentY;
            el.style.transform = `translate3d(0, calc(var(--safe-t, 0px) + ${y + 8}px), 0)`;
            el.style.opacity = `${Math.min(1, y / 28)}`;
          }
        }
      });
    }
  };
  const onTouchEnd = () => {
    const st = ptrRef.current;
    ptrRef.current = null;
    if (!st || !st.active) return;
    if (st.rafId) cancelAnimationFrame(st.rafId);

    const el = indicatorRef.current;
    if (st.armed && !refreshing) {
      setRefreshing(true);
      if (el) {
        el.style.transition = 'transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 200ms ease';
        el.style.transform = 'translate3d(0, calc(var(--safe-t, 0px) + 52px), 0)';
        el.style.opacity = '1';
      }
      void Promise.allSettled([syncNow(), refreshRates(s.baseCurrency), import('@/services/inbox').then((m) => m.refreshInbox())]).finally(() => {
        haptic('success');
        window.setTimeout(() => {
          if (indicatorRef.current) {
            indicatorRef.current.style.transition = 'transform 240ms cubic-bezier(0.2, 0, 0, 1), opacity 180ms ease';
            indicatorRef.current.style.transform = 'translate3d(0, -60px, 0)';
            indicatorRef.current.style.opacity = '0';
          }
          window.setTimeout(() => {
            setRefreshing(false);
            setArmed(false);
          }, 240);
        }, 320);
      });
    } else {
      setArmed(false);
      if (el) {
        el.style.transition = 'transform 240ms cubic-bezier(0.2, 0, 0, 1), opacity 180ms ease';
        el.style.transform = 'translate3d(0, -60px, 0)';
        el.style.opacity = '0';
      }
    }
  };

  const account = AUTH_ENABLED && auth.user;

  /** 刪除帳號：伺服器上的帳號與全部同步資料永久刪除，這台裝置的本機資料一併清除 */
  const deleteAccount = async () => {
    if (!await ask('刪除帳號？伺服器上的帳號與所有同步的資料會永久刪除，這台裝置的資料也會清除，無法復原。', { confirmText: '繼續' })) return;
    const ok = await confirmIdentity((body) => api('/auth/account', { method: 'DELETE', body }), { title: '輸入密碼，確認刪除帳號', confirmText: '刪除帳號', danger: true });
    if (ok) await wipeLocalData();
  };

  return (
    <main
      className="page settings-page"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {/* 下拉刷新指示器（浮動膠囊，零佈局重繪硬體加速） */}
      <div
        ref={indicatorRef}
        className={`ptr-indicator${refreshing ? ' refreshing' : armed ? ' armed' : ''}`}
        aria-live="polite"
      >
        <span className="ptr-pill">
          <span className="ptr-spinner" aria-hidden="true" />
          <span>{refreshing ? '同步更新中…' : armed ? '放開立即同步' : '下拉同步'}</span>
        </span>
      </div>

      <h1 className="large-title" style={{ marginTop: 12 }}>設定</h1>

      {account && auth.user && (
        <>
          <div className="set-profile">
            <span className="cat-icon lg" aria-hidden="true">{auth.user.username.slice(0, 1).toUpperCase()}</span>
            <div className="row-main">
              <div className="row-title">{auth.user.username}{auth.user.role === 'admin' && <span className="chip" style={{ marginLeft: 6 }}>管理員</span>}</div>
              <div className="row-sub">{auth.user.email}{auth.status === 'offline' ? ' · 離線模式' : ''}</div>
            </div>
          </div>
          <Group>
            <SyncRow />
          </Group>
        </>
      )}

      {/* 1. 記帳核心 */}
      <Group title="記帳與分類">
        <Row icon="tags" tint="#FF375F" label="分類、標籤與規則" onClick={() => setCatOpen(true)} />
        <Row icon="slidersHorizontal" tint="#8E8E93" label="記帳格式與幣別" onClick={() => setPrefsOpen(true)}>
          <span className="row-value muted" style={{ fontSize: '0.85rem' }}>{s.baseCurrency} · 每月 {s.monthStartDay === 31 ? '月底' : `${s.monthStartDay}日`}</span>
        </Row>
      </Group>

      {/* 2. 智慧與自動化 */}
      <Group title="自動化與智慧">
        <Row icon="receipt" tint="#30D158" label="自動記帳與對帳" onClick={() => setAutoOpen(true)} />
        <Row icon="ai" tint="#17181c" label="AI 助理與智慧偵測" hint="開啟 AI 記帳與諮詢、送出內容去識別化隱私防護，以及本機純離線規則偵測重複扣款與預算超支警示。" onClick={() => setAiOpen(true)} />
      </Group>

      {/* 3. 介面與通知 */}
      <Group title="介面與通知">
        <Row icon="palette" tint="#0A84FF" label="外觀與首頁版面" onClick={() => setLookOpen(true)}>
          <span className="row-value muted" style={{ fontSize: '0.85rem' }}>{s.theme === 'system' ? '跟隨系統' : s.theme === 'dark' ? '深色' : '淺色'} · {ACCENTS.find((a) => a.key === s.accent)?.name ?? ''}</span>
        </Row>
        <Row icon="bell" tint="#FF3B30" label="通知與市場整合" onClick={() => setIntegOpen(true)} />
      </Group>

      {/* 4. 系統與資料 */}
      <Group title="系統與資料">
        {account && (
          <Row icon="shieldCheck" tint="#5E5CE6" label="帳號安全與隱私" onClick={() => setSecOpen(true)} />
        )}
        <Row icon="database" tint="#0A84FF" label="資料備份與維護" onClick={() => setDataOpen(true)} />
        <Row icon="info" tint="#8E8E93" label="關於 Aster" onClick={() => setAboutOpen(true)}>
          <span className="row-value muted" style={{ fontSize: '0.85rem' }}>v{__APP_VERSION__}</span>
        </Row>
      </Group>

      {/* 危險操作區 */}
      <Group id="danger">
        {account && (
          <Row danger label="登出" onClick={async () => { if (await ask('確定登出？帳目已同步到伺服器，在任何裝置重新登入即可繼續使用。')) void auth.logout(); }} />
        )}
        {account && <Row danger label="刪除帳號" sub="刪除伺服器上的帳號與全部資料" onClick={() => void deleteAccount()} />}
        <Row danger label="清除所有資料" sub="刪除此裝置上的全部資料，無法復原" onClick={async () => {
          if (!await ask('確定要刪除所有資料？此動作無法復原。')) return;
          if (await askInput({ title: '輸入「刪除」確認', placeholder: '刪除', confirmText: '清除', danger: true }) !== '刪除') return;
          await db.delete();
          location.replace('/');
        }} />
      </Group>

      <p className="disclaimer">2026.02.03 · Qiyen 著</p>

      {/* 集合面板 Sheet */}
      <TaxonomyHubSheet open={catOpen} onClose={() => setCatOpen(false)} />
      <AutoRecordHubSheet open={autoOpen} onClose={() => setAutoOpen(false)} />
      <AiHubSheet open={aiOpen} onClose={() => setAiOpen(false)} />
      <AppearanceSheet open={lookOpen} onClose={() => setLookOpen(false)} />
      <PrefsSheet open={prefsOpen} onClose={() => setPrefsOpen(false)} />
      <IntegrationHubSheet open={integOpen} onClose={() => setIntegOpen(false)} />
      <SecurityHubSheet
        open={secOpen}
        onClose={() => setSecOpen(false)}
        onOpenEnc={() => setEncOpen(true)}
        onOpenPw={() => setPwOpen(true)}
      />
      <DataHubSheet open={dataOpen} onClose={() => setDataOpen(false)} />
      <AboutHubSheet open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* 細部彈窗 */}
      <EncryptionSheet open={encOpen} onClose={() => setEncOpen(false)} />
      <Sheet open={pwOpen} onClose={() => setPwOpen(false)} title="變更密碼">
        {pwOpen && <ChangePasswordForm onDone={() => { setPwOpen(false); useUI.getState().showSnack({ text: '密碼已變更，其他裝置已登出' }); }} />}
      </Sheet>
    </main>
  );
}
