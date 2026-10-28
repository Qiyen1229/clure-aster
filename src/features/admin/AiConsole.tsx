/**
 * AI 主控台（/admin/ai）：供應商連線狀況（可即時測試）、用量、各使用者用量、最近呼叫，以及開關與額度設定。
 * API Key 只存在伺服器 .env；這裡只顯示最後 4 碼。連線狀況（成功／失敗次數、最近錯誤）記在記憶體，API 重啟會歸零。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/services/api';
import { useUI } from '@/stores/ui';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { SwitchField } from '@/ui/form';

interface Provider {
  name: string; model: string; base_host: string; configured: boolean; key_hint: string; cooling_down: boolean; cooldown_remaining_s: number;
  ok: number; fail: number; last_ok_at: number | null; last_fail_at: number | null; last_error: string; last_latency_ms: number | null;
}
interface Settings {
  enabled: boolean; user_daily: number; user_weekly: number; user_monthly: number; global_daily: number; admin_daily: number; admin_weekly: number; admin_monthly: number; overridden: boolean;
  used_today: number; used_today_by_provider: Record<string, number>;
}
interface Console {
  settings: Settings; providers: Provider[];
  totals: { today: number; week: number; month: number };
  by_role: Record<'user' | 'admin', { today: number; week: number; month: number }>;
  by_user: { user_id: number; username: string; role: 'user' | 'admin'; today: number; week: number; month: number }[];
  recent: { at: string; username: string; kind: string; provider: string; model: string; cost: number }[];
  daily: { date: string; count: number }[]; timezone: string; server_time: string;
}
interface TestResult { name: string; ok: boolean; latency_ms: number | null; detail: string }

const KIND: Record<string, string> = {
  search_plan: 'AI 搜尋', explain: '專案／帳戶解說',
  parse_entry: '一句話記帳', ask: '問 AI', budget_plan: '預算建議', insights: '白話解讀', categorize: '整理分類', receipt: '拍照記帳',
};
const epoch = (t: number | null) => (t ? new Date(t * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
const utc = (s: string) => new Date(s + 'Z').toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function status(p: Provider): { icon: string; text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (!p.configured) return { icon: '⚪️', text: '未設定（缺 Key／網址／模型）', tone: 'muted' };
  if (p.cooling_down) return { icon: '🟠', text: `冷卻中（連續失敗，約 ${p.cooldown_remaining_s} 秒後再試）`, tone: 'warn' };
  if (p.last_fail_at && (!p.last_ok_at || p.last_fail_at > p.last_ok_at)) return { icon: '🔴', text: '最近一次失敗', tone: 'bad' };
  if (p.last_ok_at) return { icon: '🟢', text: '正常', tone: 'ok' };
  return { icon: '🔵', text: '已設定，尚未測試', tone: 'muted' };
}

export default function AiConsole() {
  const [d, setD] = useState<Console | null>(null);
  const [err, setErr] = useState('');
  const [tests, setTests] = useState<Record<string, TestResult | 'busy'>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await api<Console>('/admin/ai/console')); setErr(''); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '載入失敗'); }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    return () => clearInterval(id);
  }, [load]);

  const test = async (name: string) => {
    setTests((t) => ({ ...t, [name]: 'busy' }));
    try {
      const r = await api<TestResult>('/admin/ai/test', { method: 'POST', body: { provider: name } });
      setTests((t) => ({ ...t, [name]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { name, ok: false, latency_ms: null, detail: (e as Error).message } }));
    }
    void load();
  };
  const testAll = async () => { for (const p of d?.providers ?? []) if (p.configured) await test(p.name); };
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api('/admin/ai', { method: 'PATCH', body });
      setDraft({});
      useUI.getState().showSnack({ text: '已更新 AI 設定' });
      await load();
    } catch (e) { useUI.getState().showSnack({ text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (err && !d) return <EmptyState emoji="⚠️" title="無法載入 AI 主控台" text={err} action={<button className="btn small" onClick={() => void load()}>重試</button>} />;
  if (!d) return <SkeletonRows n={4} />;
  const { settings: st } = d;
  const ready = d.providers.filter((p) => p.configured);
  const healthy = ready.filter((p) => status(p).tone === 'ok').length;
  const summary = !ready.length ? { icon: '⚠️', text: '尚未設定任何供應商：到 NAS 的 .env 填入 API Key，再 docker compose up -d' }
    : !st.enabled ? { icon: '⏸', text: 'AI 功能已由管理員關閉' }
    : { icon: healthy ? '✅' : '🔎', text: `${ready.length} 個供應商已設定，${healthy} 個確認正常${healthy ? '' : '（按「全部測試」確認 Key 是否有效）'}` };
  const limits: [string, string, number][] = [
    ['user_daily', '一般使用者・每人每日', st.user_daily], ['user_weekly', '一般使用者・每人每週', st.user_weekly], ['user_monthly', '一般使用者・每人每月', st.user_monthly],
    ['admin_daily', '管理員・每人每日', st.admin_daily], ['admin_weekly', '管理員・每人每週', st.admin_weekly], ['admin_monthly', '管理員・每人每月', st.admin_monthly],
    ['global_daily', '全站每日（兩者合計）', st.global_daily],
  ];
  const dirty = limits.some(([k, , v]) => draft[k] !== undefined && draft[k] !== String(v));
  const max = Math.max(1, ...d.daily.map((x) => x.count));

  return (
    <>
      <div className="card" role="status" style={{ marginBottom: 12 }}>
        <div className="row-title">{summary.icon} {summary.text}</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>伺服器時間 {utc(d.server_time)}（額度以 {d.timezone} 計算）</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn small" onClick={() => void testAll()} disabled={!ready.length}>全部測試</button>
          <button className="btn small ghost" onClick={() => void load()}>重新整理</button>
        </div>
      </div>

      <div className="section-title">供應商（依嘗試順序）</div>
      <div className="list">
        {d.providers.length === 0 && <div className="row muted">CLURE_AI_PROVIDERS 沒有任何供應商</div>}
        {d.providers.map((p, i) => {
          const s = status(p);
          const t = tests[p.name];
          return (
            <div key={p.name} className="row" style={{ display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <span className="row-title">{i + 1}. {p.name} <span className="muted">{s.icon} {s.text}</span></span>
                <button className="btn small" disabled={!p.configured || t === 'busy'} onClick={() => void test(p.name)}>{t === 'busy' ? '測試中…' : '測試連線'}</button>
              </div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                模型 {p.model || '（未設定）'}　主機 {p.base_host || '—'}　Key {p.key_hint || '（未設定）'}
              </div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                自上次重啟：成功 {p.ok} 次、失敗 {p.fail} 次　最近成功 {epoch(p.last_ok_at)}{p.last_latency_ms !== null ? `（${p.last_latency_ms} ms）` : ''}
              </div>
              {p.last_error && <div className="row-sub" style={{ whiteSpace: 'normal', color: s.tone === 'ok' ? undefined : 'var(--danger)' }}>最近錯誤 {epoch(p.last_fail_at)}：{p.last_error}</div>}
              {t && t !== 'busy' && (
                <div role="status" style={{ marginTop: 4, color: t.ok ? 'var(--success, #30D158)' : 'var(--danger)' }}>
                  {t.ok ? '✅' : '❌'} {t.detail}{t.latency_ms !== null ? `（${t.latency_ms} ms）` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="set-note">「測試連線」會送 1 次極小的請求（用掉供應商 1 次免費額度，不扣使用者額度），成功會解除冷卻。Key 只存在伺服器的 .env，這裡只顯示最後 4 碼。</p>

      <div className="section-title">用量（次）</div>
      <div className="admin-grid">
        {([['今日', d.totals.today, st.global_daily], ['本週', d.totals.week, 0], ['本月', d.totals.month, 0]] as const).map(([k, v, cap]) => (
          <div key={k} className={`admin-stat${cap && v >= cap ? ' warn' : ''}`}>
            <div className="k">{k}{cap ? `（全站上限 ${cap}）` : ''}</div>
            <div className="v num">{v}</div>
          </div>
        ))}
      </div>
      {Object.keys(st.used_today_by_provider).length > 0 && (
        <p className="set-note">今日各供應商：{Object.entries(st.used_today_by_provider).map(([k, v]) => `${k} ${v}`).join('、')}</p>
      )}
      <div className="list" aria-label="近 7 天每日用量">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 90, padding: '10px 14px' }}>
          {d.daily.map((x) => (
            <div key={x.date} style={{ flex: 1, textAlign: 'center', fontSize: 11 }}>
              <div className="num">{x.count}</div>
              <div style={{ height: Math.max(2, Math.round((x.count / max) * 50)), background: 'var(--accent)', borderRadius: 3, margin: '2px 0' }} />
              <div className="muted">{x.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="list">
        {(['user', 'admin'] as const).map((r) => (
          <div key={r} className="row">
            <span className="row-main row-title">{r === 'admin' ? '管理員' : '一般使用者'}</span>
            <span className="num muted">今日 {d.by_role[r].today} ／ 本週 {d.by_role[r].week} ／ 本月 {d.by_role[r].month}</span>
          </div>
        ))}
      </div>

      <div className="section-title">各使用者用量（本月前 30 名）</div>
      <div className="list">
        {d.by_user.length === 0 && <div className="row muted">本月還沒有人使用</div>}
        {d.by_user.map((u) => (
          <div key={u.user_id} className="row">
            <span className="row-main row-title">{u.username}{u.role === 'admin' ? ' 🛡' : ''}</span>
            <span className="num muted">今日 {u.today} ／ 本週 {u.week} ／ 本月 {u.month}</span>
          </div>
        ))}
      </div>

      <div className="section-title">最近 20 次呼叫</div>
      <div className="list">
        {d.recent.length === 0 && <div className="row muted">還沒有呼叫紀錄</div>}
        {d.recent.map((r, i) => (
          <div key={i} className="row">
            <span className="row-main"><span className="row-title">{r.username}　{KIND[r.kind] ?? r.kind}</span><span className="row-sub" style={{ display: 'block' }}>{r.provider}　{r.model}</span></span>
            <span className="muted">{utc(r.at)}</span>
          </div>
        ))}
      </div>
      <p className="set-note">不記錄使用者輸入的內容，只記次數、供應商與模型。失敗的呼叫不會出現在這裡（看供應商卡片的「最近錯誤」或 docker compose logs api）。</p>

      <div className="section-title">開關與額度</div>
      <div className="list">
        <SwitchField label="AI 功能" checked={st.enabled} onChange={(v) => { if (!busy) void save({ enabled: v }); }}
          sub={st.overridden ? '關閉後所有使用者都不能用 AI（記帳規則解析不受影響）' : '額度目前沿用 .env 預設值；在這裡儲存後以後台為準'} />
        {limits.map(([k, label, v]) => (
          <label key={k} className="field">
            <span className="label" style={{ flex: 1, width: 'auto' }}>{label}（次，0＝不限）</span>
            <input className="num" inputMode="numeric" style={{ width: 80, textAlign: 'right' }} value={draft[k] ?? String(v)}
              onChange={(e) => setDraft({ ...draft, [k]: e.target.value.replace(/\D/g, '').slice(0, 7) })} />
          </label>
        ))}
        <div className="row">
          <button className="btn small" disabled={!dirty || busy} onClick={() => void save(Object.fromEntries(limits.filter(([k]) => draft[k] !== undefined).map(([k]) => [k, Number(draft[k] || 0)])))}>儲存額度</button>
          <span className="row-sub" style={{ whiteSpace: 'normal' }}>每日 00:00、每週一 00:00、每月 1 日重置。全站每日上限建議設在免費供應商的每日額度以內。</span>
        </div>
      </div>
    </>
  );
}
