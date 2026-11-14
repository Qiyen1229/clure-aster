/**
 * 隱私權政策與服務條款（公開頁面：沒登入也能看，登入／註冊頁底下與設定的「關於」都有連結）。
 * 內容依 Aster 實際的資料流寫成；自架者若改了架構（例如換 AI 供應商），請同步修改這裡。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '@/ui/Icon';

const UPDATED = '2026-11-08';

function Shell({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <main className="page legal">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => (history.length > 1 ? navigate(-1) : navigate('/'))}><Icon name="chevronL" /></button>
        <h1>{title}</h1>
        <div style={{ width: 44 }} />
      </header>
      <p className="muted" style={{ margin: '0 4px 8px' }}>最後更新：{UPDATED}</p>
      {children}
      <p className="muted" style={{ margin: '16px 4px', fontSize: '0.8rem' }}>
        <Link to="/privacy" className="accent">隱私權政策</Link>　·　<Link to="/terms" className="accent">服務條款</Link>
      </p>
    </main>
  );
}

const H = ({ children }: { children: ReactNode }) => <h2 className="legal-h">{children}</h2>;

function useContact(): string {
  const [contact, setContact] = useState('');
  useEffect(() => {
    void fetch('/api/auth/forgot-info', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((j: { contact?: string } | null) => setContact(j?.contact ?? ''), () => undefined);
  }, []);
  return contact;
}

export function PrivacyPage() {
  const contact = useContact();
  return (
    <Shell title="隱私權政策">
      <p>Aster 記帳是自架式的記帳軟體：你的資料存在你的裝置，以及架設這個站台的人（下稱「管理員」）維護的伺服器上。這份政策說明哪些資料會被存下來、用在哪裡，以及你能怎麼處理。</p>
      <H>我們存哪些資料</H>
      <ul>
        <li><b>帳號</b>：使用者名稱、Email、密碼（只存雜湊，連管理員都看不到原文）。</li>
        <li><b>記帳資料</b>：帳戶、帳目、預算、投資等。存在你的裝置，登入後同步到伺服器，讓你在多台裝置看到同樣的內容。你可以開啟<b>端對端加密</b>，加密後伺服器與管理員都讀不到內容。</li>
        <li><b>登入與安全紀錄</b>：登入時間、IP、瀏覽器種類，用於「已登入的裝置」與異常偵測；安全審計日誌不包含任何記帳內容。</li>
        <li><b>收件匣暫存</b>：你設定的 iPhone 捷徑送來的消費通知，處理後立即刪除，30 天沒處理也會自動清除。</li>
        <li><b>推播與通知設定</b>：只有你開啟時才會保存推播訂閱、外部通知（Discord、Telegram 等）的憑證，憑證加密存放。</li>
      </ul>
      <H>Cilo（選用）</H>
      <p>Cilo 預設關閉。你開啟並同意資料傳送後，才會把<b>去識別化的收支統計</b>、你輸入的文字或你拍的收據送到 AI 供應商（由管理員設定，例如 Google Gemini）處理，並受該供應商的條款約束；部分供應商的免費方案可能把資料用於改進服務，不希望如此請不要開啟。App 內「Cilo設定」可以隨時關閉，也能查看送出過什麼。</p>
      <H>我們不做的事</H>
      <ul>
        <li>不放廣告、不出售或交換你的資料、不使用第三方追蹤或分析工具。</li>
        <li>除你主動開啟的功能外，只會連線取得匯率與股價。</li>
      </ul>
      <H>你的選擇</H>
      <ul>
        <li><b>匯出</b>：「設定 → 資料 → 備份」可以匯出完整備份。</li>
        <li><b>刪除帳號</b>：「設定 → 帳號與資料管理 → 刪除帳號」會立即永久刪除伺服器上的帳號與所有同步資料。你自己匯出的備份檔不受影響。</li>
        <li><b>只留在本機</b>：不登入、不同步，資料就只存在這台裝置。</li>
      </ul>
      <H>安全</H>
      <p>連線使用 HTTPS；密碼以 Argon2id 雜湊；可啟用雙因素驗證、App 鎖與「已登入的裝置」管理。沒有任何系統能保證百分之百安全，建議定期備份。</p>
      <H>聯絡</H>
      <p>隱私相關問題請洽架設這個站台的管理員{contact ? <>：<b>{contact}</b></> : '（站台的聯絡方式請向管理員索取）'}。</p>
    </Shell>
  );
}

export function TermsPage() {
  const contact = useContact();
  return (
    <Shell title="服務條款">
      <p>使用 Aster 記帳即表示你同意以下條款。</p>
      <H>這是什麼</H>
      <p>Aster 記帳是協助你記錄與整理收支的工具。所有試算、統計、預測、Cilo 回覆與提醒（含稅務、退休、投資、貸款）<b>僅供參考，不構成財務、稅務、法律或投資建議</b>，重要決定請諮詢專業人士並以官方資料為準。</p>
      <H>你的帳號</H>
      <ul>
        <li>請妥善保管密碼與備援碼，帳號下的操作視為你本人所為。</li>
        <li>請勿用於違法用途，或干擾、攻擊服務與其他使用者。</li>
      </ul>
      <H>資料與備份</H>
      <p>你的記帳資料屬於你。請定期備份；若忘記端對端加密的密碼，沒有任何人能幫你解開。</p>
      <H>服務提供</H>
      <p>服務由架設這個站台的管理員提供，不保證不中斷或不出錯。管理員可為維護或安全理由暫停服務，或停用違規帳號。</p>
      <H>責任限制</H>
      <p>在法律允許的範圍內，因使用或無法使用本服務造成的任何損失（包含資料遺失、計算誤差），管理員與軟體作者不負賠償責任。</p>
      <H>變更與終止</H>
      <p>條款有重大變更時會在 App 內公告。你可以隨時刪除帳號並停止使用。</p>
      <H>聯絡</H>
      <p>有任何問題請洽管理員{contact ? <>：<b>{contact}</b></> : ''}。</p>
    </Shell>
  );
}
