/**
 * 特色功能介紹：註冊後的導覽、舊使用者更新後的「新功能」介紹共用。
 * - FeatureCards：可左右滑的功能卡片
 * - TryQuickEntry：導覽中直接試打一句話，即時看到會怎麼記（不會真的記帳）
 * - WhatsNewSheet：更新到新版本後顯示一次
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { formatMoney, toMinor } from '@/domain/money';
import { parseEntries, shortDate, type NlpAccount, type NlpCategory } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Sheet } from '@/ui/Sheet';

export const WHATS_NEW_VERSION = '1.3.0';

interface Feature { icon: string; title: string; text: string; where: string; to?: string; needsServer?: boolean }

export const FEATURES: Feature[] = [
  { icon: '🎙', title: '一句話記帳', text: '說或打「昨天午餐 150 刷玉山卡」就記好；「早餐 60 午餐 120」一次記兩筆。', where: '點 ＋ 記帳，最上面的「一句話記帳」' },
  { icon: '📥', title: '刷卡自動進收件匣', text: 'Apple Pay 付款、銀行刷卡簡訊、對 Siri 說一句話，iPhone 捷徑會自動送來，確認一下就記好。', where: '設定 → 自動記帳收件匣', to: '/inbox', needsServer: true },
  { icon: '🔮', title: '現金流預測', text: '把薪水、房租、卡費、分期都算進去，提前告訴你哪天哪個帳戶會不夠付。', where: '報表 → 現金流預測', to: '/reports/cashflow' },
  { icon: '📊', title: '每週／每月摘要', text: '每週一早上告訴你上週花了多少、比前一週多還少、哪一類變多了。', where: '報表 → 週報／月報', to: '/reports/summary?unit=week' },
  { icon: '💬', title: '用問的查帳', text: '在搜尋直接問「上個月吃飯花多少」「今年最大一筆」，馬上回答。', where: '首頁右上角 🔍', to: '/search' },
  { icon: '🧾', title: '電子發票自動記帳', text: '輸入手機條碼載具，雲端發票自動記帳；也能拍紙本發票的 QR Code。', where: '設定 → 電子發票', to: '/settings/invoice' },
];

export const visibleFeatures = () => FEATURES.filter((f) => !f.needsServer || AUTH_ENABLED);

export function FeatureCards({ onGo }: { onGo?: (to: string) => void }) {
  const list = visibleFeatures();
  const [idx, setIdx] = useState(0);
  return (
    <>
      <div className="feat-track" role="list" aria-label="特色功能"
        onScroll={(e) => { const el = e.currentTarget; setIdx(Math.round(el.scrollLeft / Math.max(1, el.clientWidth * 0.84))); }}>
        {list.map((f) => (
          <div key={f.title} className="feat-card" role="listitem">
            <div className="feat-icon" aria-hidden="true">{f.icon}</div>
            <h2>{f.title}</h2>
            <p>{f.text}</p>
            <div className="feat-where">📍 {f.where}</div>
            {onGo && f.to && <button className="btn tinted small" onClick={() => onGo(f.to!)}>去看看</button>}
          </div>
        ))}
      </div>
      <div className="steps" aria-hidden="true" style={{ marginTop: 10 }}>
        {list.map((f, i) => <i key={f.title} className={i === Math.min(idx, list.length - 1) ? 'on' : ''} />)}
      </div>
    </>
  );
}

const TRY_EXAMPLES = ['昨天午餐 150', '早餐 60 午餐 120 飲料 55', '計程車兩百三', '領薪水 5萬2'];

/** 導覽中試打一句話：用預設分類與剛建立的帳戶即時解析 */
export function TryQuickEntry({ accountName, currency }: { accountName: string; currency: string }) {
  const [text, setText] = useState('');
  const [cats, setCats] = useState<NlpCategory[]>([]);
  useEffect(() => {
    void db.categories.toArray().then((rows) => {
      const list = rows.length ? rows : buildDefaultCategories();
      setCats(list.filter((c) => !c.system && !c.archived).map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId })));
    });
  }, []);
  const catName = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);
  const accounts: NlpAccount[] = accountName.trim() ? [{ id: 'new', name: accountName.trim(), type: 'cash' }] : [];
  const today = todayKey();
  const drafts = text.trim() ? parseEntries(text, { today, accounts, categories: cats }) : [];
  return (
    <div className="try-box">
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="打一句話試試，例如：昨天午餐 150" aria-label="試試一句話記帳" />
      <div className="quick-examples">
        {TRY_EXAMPLES.map((x) => <button key={x} className="pill" onClick={() => setText(x)}>{x}</button>)}
      </div>
      {text.trim() && (
        drafts.length === 0 ? <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.85rem' }}>還找不到金額，加上數字試試（「午餐 120」）。</p> : (
          <div className="list" style={{ marginTop: 8 }}>
            {drafts.map((d, i) => (
              <div key={i} className="row">
                <span className="row-main">
                  <span className="row-title">{d.note || (d.categoryId ? catName.get(d.categoryId) : '') || (d.kind === 'income' ? '收入' : '支出')}</span>
                  <span className="row-sub" style={{ display: 'block' }}>
                    {shortDate(d.date, today)} · {d.kind === 'income' ? '收入' : d.kind === 'transfer' ? '轉帳' : '支出'}{d.categoryId ? ` · ${catName.get(d.categoryId)}` : ''}{accountName.trim() ? ` · ${accountName.trim()}` : ''}
                  </span>
                </span>
                <span className={`num ${d.kind === 'income' ? 'pos' : 'neg'}`}>{formatMoney(toMinor(d.amount, d.currency ?? currency), d.currency ?? currency)}</span>
              </div>
            ))}
          </div>
        )
      )}
      <p className="muted" style={{ fontSize: '0.78rem', margin: '8px 0 0' }}>這裡只是試試看，不會真的記帳。之後點 ＋ 就能用，iPhone 也可以按鍵盤上的 🎤 用說的。</p>
    </div>
  );
}

/** 更新到新版本後顯示一次新功能介紹 */
export function WhatsNewSheet() {
  const navigate = useNavigate();
  const seen = useSettings((s) => s.seenWhatsNew);
  const onboarded = useSettings((s) => s.onboarded);
  const ready = useSettings((s) => s.ready);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!ready || !onboarded || seen === WHATS_NEW_VERSION) return;
    // 記帳面板開著時（例如從捷徑深層連結進來）先不打擾，關掉後再顯示
    const t = setInterval(() => {
      if (useUI.getState().add.open || document.visibilityState !== 'visible') return;
      setOpen(true);
      clearInterval(t);
    }, 1200);
    return () => clearInterval(t);
  }, [ready, onboarded, seen]);
  const close = () => { setOpen(false); useSettings.getState().set('seenWhatsNew', WHATS_NEW_VERSION); };
  return (
    <Sheet open={open} onClose={close} title={`Aster ${WHATS_NEW_VERSION} 新功能`}>
      <p className="muted" style={{ margin: '0 0 12px' }}>左右滑動看看，點「去看看」直接打開。</p>
      <FeatureCards onGo={(to) => { close(); navigate(to); }} />
      <button className="btn" style={{ marginTop: 12 }} onClick={close}>開始使用</button>
    </Sheet>
  );
}
