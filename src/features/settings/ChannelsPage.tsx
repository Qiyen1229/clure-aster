/**
 * 外部通知：把異常大額、預算超支、週報月報、發票中獎…直接推到你的 Discord、Telegram、LINE 或任何 Webhook。
 * 由伺服器發送（所以 App 沒開也收得到週報、繳款提醒）；機密加密存在你自己的伺服器。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createChannel, DEFAULT_EVENTS, deleteChannel, EVENT_INFO, KIND_INFO, listChannels, patchChannel, testChannel,
  type Channel, type ChannelKind, type OutEvent,
} from '@/services/outgoing';
import { schedulePush } from '@/services/push';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { useSync } from '@/services/sync';
import { useUI } from '@/stores/ui';
import { EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { SwitchField, TextField } from '@/ui/form';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { Guide } from './GuideView';

const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });
const when = (iso: string | null) => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export default function ChannelsPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<Channel[] | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const detail = useSettings((s) => s.outgoingDetail);
  const set = useSettings((s) => s.set);
  const e2ee = useSync((s) => !!s.e2ee?.enabled);

  const load = useCallback(async () => {
    try { setList(await listChannels()); setErr(''); } catch (e) { setErr((e as Error).message); setList([]); }
  }, []);
  useEffect(() => { if (AUTH_ENABLED) void load(); else setList([]); }, [load]);
  /** 通道有增減或開關後，週報、繳款提醒的排程也要跟著更新 */
  const changed = async () => { await load(); void schedulePush().catch(() => undefined); };

  const test = async (c: Channel) => {
    setBusy(c.id);
    try { const r = await testChannel(c.id); snack(r.ok ? `已送到 ${c.name}，請到對方的 App 確認` : `送不出去：${r.detail}`, 7000); await load(); }
    catch (e) { snack((e as Error).message, 6000); } finally { setBusy(null); }
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>外部通知</h1>
        <button className="icon-btn" aria-label="新增通知通道" onClick={() => setAdding(true)} disabled={!AUTH_ENABLED}><Icon name="plus" /></button>
      </header>

      {!AUTH_ENABLED ? (
        <EmptyState emoji="🔌" title="需要伺服器版" text="外部通知由你的 Aster 伺服器發送，請登入伺服器版 App 後使用。" />
      ) : !list ? <SkeletonRows n={3} /> : (
        <>
          <p className="muted" style={{ fontSize: '0.85rem', margin: '4px 4px 12px' }}>
            異常大額、預算超支、週報月報、發票中獎…直接推到你的 Discord、Telegram、LINE 或任何 Webhook。由伺服器發送，App 沒開也收得到週報與繳款提醒。
          </p>
          {err && <p className="muted" style={{ color: 'var(--danger)' }}>{err}</p>}
          {list.length === 0 && !err ? (
            <EmptyState emoji="📣" title="還沒有通知通道" text="新增一個通道，異常和預算警示就會直接傳到你的聊天軟體。" action={<button className="btn small" onClick={() => setAdding(true)}>新增通道</button>} />
          ) : list.map((c) => <ChannelCard key={c.id} c={c} busy={busy === c.id} onTest={() => void test(c)} onChange={changed} />)}

          <div className="section-title">設定教學（點開看步驟）</div>
          {(['discord', 'telegram', 'line', 'webhook'] as ChannelKind[]).map((k) => <Guide key={k} kind={k} />)}

          <div className="section-title">隱私</div>
          <div className="list">
            <SwitchField label="訊息包含金額與名稱" sub={e2ee ? '你啟用了端對端加密：關閉時只送「預算提醒」這類通用標題，不送金額與商家，避免內容經過聊天軟體' : '關閉時只送通用標題，不送金額與商家'} checked={detail} onChange={(v) => set('outgoingDetail', v)} />
          </div>
          <p className="muted" style={{ fontSize: '0.78rem', margin: '8px 4px' }}>
            通道的網址與權杖以 AES-256-GCM 加密後存在你的伺服器。訊息會經過 Discord、Telegram、LINE 的伺服器，請不要把含有敏感資訊的訊息送到不信任的頻道；排程的週報、月報本來就只有標題，不含金額。
          </p>
        </>
      )}

      <Sheet open={adding} onClose={() => setAdding(false)} title="新增通知通道">
        {adding && <AddForm onDone={() => { setAdding(false); void changed(); }} />}
      </Sheet>
    </main>
  );
}

function ChannelCard({ c, busy, onTest, onChange }: { c: Channel; busy: boolean; onTest: () => void; onChange: () => Promise<void> }) {
  const [edit, setEdit] = useState(false);
  const info = KIND_INFO[c.kind];
  const toggle = async (ev: OutEvent) => {
    const events = c.events.includes(ev) ? c.events.filter((x) => x !== ev) : [...c.events, ev];
    try { await patchChannel(c.id, { events }); await onChange(); } catch (e) { snack((e as Error).message); }
  };
  return (
    <div className="card" style={{ opacity: c.enabled ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="dur-icon" aria-hidden="true">{info.icon}</span>
        <div className="row-main">
          <div style={{ fontWeight: 650 }}>{c.name}</div>
          <div className="row-sub">{info.label}・{c.hint}</div>
        </div>
        <SwitchField label="" checked={c.enabled} onChange={(v) => { void patchChannel(c.id, { enabled: v }).then(onChange).catch((e) => snack((e as Error).message)); }} />
      </div>
      <div className="row-sub" style={{ margin: '8px 0', whiteSpace: 'normal', color: c.last_error ? 'var(--danger)' : undefined }}>
        {c.last_error ? `❌ ${c.last_error}` : c.last_ok_at ? `✅ 最近成功 ${when(c.last_ok_at)}` : '尚未發送過，按「傳送測試」確認'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(Object.keys(EVENT_INFO) as OutEvent[]).map((ev) => (
          <button key={ev} className="pill" aria-pressed={c.events.includes(ev)} title={EVENT_INFO[ev].sub} onClick={() => void toggle(ev)}>{EVENT_INFO[ev].label}</button>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn small tinted" style={{ flex: 1 }} disabled={busy} onClick={onTest}>{busy ? '傳送中…' : '傳送測試'}</button>
        <button className="btn small secondary" style={{ flex: 1 }} onClick={() => setEdit(true)}>換權杖</button>
        <button className="btn small tinted" style={{ flex: 1, color: 'var(--danger)' }} onClick={async () => {
          if (!window.confirm(`刪除「${c.name}」？之後不會再傳到這裡。`)) return;
          try { await deleteChannel(c.id); await onChange(); } catch (e) { snack((e as Error).message); }
        }}>刪除</button>
      </div>
      <Sheet open={edit} onClose={() => setEdit(false)} title={`更換「${c.name}」的設定`}>
        {edit && <ConfigFields kind={c.kind} submitLabel="儲存" onSubmit={async (config) => { await patchChannel(c.id, { config }); snack('已更新'); setEdit(false); await onChange(); }} />}
      </Sheet>
    </div>
  );
}

function ConfigFields({ kind, submitLabel, onSubmit }: { kind: ChannelKind; submitLabel: string; onSubmit: (config: Record<string, string>) => Promise<void> }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const f = (k: string) => (x: string) => setV((o) => ({ ...o, [k]: x.trim() }));
  const submit = async () => {
    setBusy(true);
    try { await onSubmit(v); } catch (e) { snack((e as Error).message, 7000); } finally { setBusy(false); }
  };
  return (
    <>
      <Guide kind={kind} />
      <div className="list">
        {kind === 'discord' && <TextField label="Webhook 網址" value={v.url ?? ''} onChange={f('url')} placeholder="https://discord.com/api/webhooks/…" maxLength={300} type="url" />}
        {kind === 'telegram' && <><TextField label="Bot 權杖" value={v.token ?? ''} onChange={f('token')} placeholder="123456:ABC…" maxLength={80} /><TextField label="Chat ID" value={v.chat_id ?? ''} onChange={f('chat_id')} placeholder="例如 123456789 或 -100…" maxLength={40} /></>}
        {kind === 'line' && <><TextField label="Channel access token" value={v.token ?? ''} onChange={f('token')} maxLength={500} /><TextField label="接收對象 ID" value={v.to ?? ''} onChange={f('to')} placeholder="U…（Your user ID）" maxLength={40} /></>}
        {kind === 'webhook' && <><TextField label="網址（https）" value={v.url ?? ''} onChange={f('url')} placeholder="https://" maxLength={500} type="url" /><TextField label="簽章密鑰（選填）" value={v.secret ?? ''} onChange={f('secret')} maxLength={100} /></>}
      </div>
      <button className="btn" disabled={busy} onClick={() => void submit()}>{busy ? '處理中…' : submitLabel}</button>
    </>
  );
}

function AddForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<ChannelKind>('discord');
  const [name, setName] = useState('');
  const [events, setEvents] = useState<OutEvent[]>(DEFAULT_EVENTS);
  const toggle = (ev: OutEvent) => setEvents((e) => (e.includes(ev) ? e.filter((x) => x !== ev) : [...e, ev]));
  return (
    <>
      <Segmented value={kind} onChange={setKind} ariaLabel="類型" options={(Object.keys(KIND_INFO) as ChannelKind[]).map((k) => ({ value: k, label: KIND_INFO[k].label.replace('自訂 ', '') }))} />
      <div className="list" style={{ marginTop: 12 }}>
        <TextField label="名稱" value={name} onChange={setName} placeholder={`例如：家人${KIND_INFO[kind].label}`} maxLength={40} />
      </div>
      <div className="section-title">要收哪些通知</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {(Object.keys(EVENT_INFO) as OutEvent[]).map((ev) => <button key={ev} className="pill" aria-pressed={events.includes(ev)} onClick={() => toggle(ev)}>{EVENT_INFO[ev].label}</button>)}
      </div>
      <ConfigFields key={kind} kind={kind} submitLabel="新增並傳送測試" onSubmit={async (config) => {
        if (!events.length) { snack('至少選一種通知'); return; }
        const c = await createChannel({ kind, name, config, events });
        const r = await testChannel(c.id).catch((e: Error) => ({ ok: false, detail: e.message }));
        snack(r.ok ? '已新增，測試通知已送出，請到對方的 App 確認' : `已新增，但測試失敗：${r.detail}`, 8000);
        onDone();
      }} />
    </>
  );
}
