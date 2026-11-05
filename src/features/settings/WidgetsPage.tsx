/**
 * 首頁小工具：顯示／隱藏與排序。
 */
import { useNavigate } from 'react-router-dom';
import { ALL_WIDGETS, type WidgetKey } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';

export default function WidgetsPage() {
  const navigate = useNavigate();
  const keys = useSettings((s) => s.homeWidgets);
  const set = useSettings((s) => s.set);
  const homeAiChat = useSettings((s) => s.homeAiChat);
  const hidden = ALL_WIDGETS.filter((w) => !keys.includes(w.key));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= keys.length) return;
    const n = [...keys];
    [n[i], n[j]] = [n[j], n[i]];
    set('homeWidgets', n);
  };
  const label = (k: WidgetKey) => ALL_WIDGETS.find((w) => w.key === k)?.label ?? k;
  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>首頁小工具</h1>
        <div style={{ width: 44 }} />
      </header>
      <div className="list" style={{ marginBottom: 12 }}>
        <div className="row">
          <span className="row-main"><span className="row-title">AI 小圓球</span><span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>首頁右上角（搜尋左邊）的圓球：點開後說「昨天午餐 150」記帳、問「這個月花多少」，開啟 AI 後還能問更多</span></span>
          <Switch checked={homeAiChat} label="顯示 AI 小圓球" onChange={(v) => set('homeAiChat', v)} />
        </div>
      </div>
      <div className="section-title">顯示中（依序排列在首頁最下方；預設是空的，首頁保持簡潔）</div>
      <div className="list">
        {keys.map((k, i) => (
          <div key={k} className="row">
            <span className="row-main">{label(k)}</span>
            <button className="icon-btn plain" aria-label={`${label(k)} 上移`} onClick={() => move(i, -1)}><Icon name="up" size={18} /></button>
            <button className="icon-btn plain" aria-label={`${label(k)} 下移`} onClick={() => move(i, 1)}><Icon name="down" size={18} /></button>
            <Switch checked label={`顯示 ${label(k)}`} onChange={() => set('homeWidgets', keys.filter((x) => x !== k))} />
          </div>
        ))}
        {keys.length === 0 && <div className="row muted">目前首頁沒有小工具（淨資產、投資、帳單可以在「帳戶」頁看到）；要的話從下面加回來</div>}
      </div>
      {hidden.length > 0 && (
        <>
          <div className="section-title">已隱藏</div>
          <div className="list">
            {hidden.map((w) => (
              <div key={w.key} className="row">
                <span className="row-main">{w.label}</span>
                <Switch checked={false} label={`顯示 ${w.label}`} onChange={() => set('homeWidgets', [...keys, w.key])} />
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
