/**
 * 外部通知四種通道的設定教學（資料）。內容依各平台官方文件與說明整理（2026 年 10 月查證）：
 * 畫面上的按鈕名稱各平台偶爾會改，教學裡標示「畫面可能略有不同」的地方請以實際畫面為準。
 */
import type { ChannelKind } from '@/services/outgoing';

export interface GuideStep { text: string; note?: string }
export interface Guide {
  title: string;
  /** 一句話：這個通道適合誰 */
  blurb: string;
  /** 難度、費用、額度 */
  facts: string[];
  steps: GuideStep[];
  /** 最後要貼進 Aster 的欄位 */
  paste: string[];
  troubleshoot: { q: string; a: string }[];
  links: { label: string; url: string }[];
}

export const GUIDES: Record<ChannelKind, Guide> = {
  discord: {
    title: 'Discord：複製一個網址就好',
    blurb: '最簡單。適合自己或家人看，建議開一個只有你們的私人伺服器。',
    facts: ['難度：⭐（約 1 分鐘）', '費用：免費，沒有訊息則數限制', '需要：Discord 帳號，以及該頻道的「管理 Webhook」權限（自己建的伺服器預設就有）'],
    steps: [
      { text: '沒有私人伺服器的話先建一個：左側伺服器列最下方按「＋」→「自己建立」→「僅供我和朋友使用」，取個名字（例如「Aster 通知」）。' },
      { text: '選一個要收通知的文字頻道（也可以新建一個叫「記帳通知」的頻道）。' },
      { text: '開啟該頻道的設定：在頻道名稱上按右鍵（手機長按）→「編輯頻道」，或點頻道旁的齒輪。', note: '也可以從「伺服器設定」進入，兩種路徑會到同一個地方。' },
      { text: '左邊選「整合」→「Webhook」→「新 Webhook」。', note: '畫面名稱可能略有不同，找「Integrations」或「Webhooks」。手機版的選單位置與電腦版不太一樣，建議第一次用電腦完成。' },
      { text: '可以替它取名（例如「Aster」）並換頭像，確認「頻道」是你要的那一個。' },
      { text: '按「複製 Webhook 網址」。' },
      { text: '回到 Aster：按右上角「＋」→ 選「Discord」→ 貼上網址 → 按「新增並傳送測試」。' },
    ],
    paste: ['Webhook 網址：長得像 https://discord.com/api/webhooks/數字/一長串英數字'],
    troubleshoot: [
      { q: '找不到「整合」或「Webhook」', a: '你在這個伺服器沒有「管理 Webhook」權限。請改在自己建立的伺服器操作。' },
      { q: '測試顯示 404 找不到', a: 'Webhook 已被刪除，或網址複製不完整。回 Discord 重新建立一個，再按 Aster 該通道的「換權杖」貼上。' },
      { q: '網址外流了怎麼辦', a: '知道網址的人就能在你的頻道發言。回 Discord 把這個 Webhook 刪除重建，再到 Aster 更換。' },
    ],
    links: [{ label: 'Discord 官方：Webhook 簡介', url: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks' }],
  },
  telegram: {
    title: 'Telegram：向 BotFather 要一個機器人',
    blurb: '免費、不限量、設定不難，適合通知比較多的人。',
    facts: ['難度：⭐⭐（約 3 分鐘）', '費用：免費，沒有訊息則數限制', '需要：Telegram 帳號'],
    steps: [
      { text: '在 Telegram 搜尋 @BotFather（有藍色認證勾勾的那個），開啟對話並按「開始」。' },
      { text: '傳送 /newbot。依序輸入機器人的「顯示名稱」（例如 Aster 通知）和「使用者名稱」（必須英文，且以 bot 結尾，例如 my_aster_bot）。' },
      { text: '建立成功後 BotFather 會給你一串「Bot 權杖」，格式像 123456789:AAH…（冒號前是數字）。長按複製起來。', note: '權杖等於這個機器人的密碼，不要貼到別處；外洩時對 BotFather 傳 /revoke 重新產生。' },
      { text: '搜尋你剛建立的機器人，打開對話，按「開始」並隨便傳一句話（例如 hi）。', note: '機器人不能主動找你，一定要你先傳訊息給它。' },
      { text: '取得 Chat ID：用瀏覽器打開 https://api.telegram.org/bot你的權杖/getUpdates（把「你的權杖」換成剛才那串，前面要有 bot 兩個字）。', note: '網址是 bot 接著權杖，中間沒有空格或斜線，例如 …/bot123456789:AAH…/getUpdates。' },
      { text: '在回傳的文字中找 "chat":{"id": 後面的數字，那就是 Chat ID（例如 123456789）。' },
      { text: '想送到群組：把機器人加進群組，在群組傳一則訊息後，再開同一個 getUpdates 網址，群組的 id 是負數（例如 -1001234567890）。' },
      { text: '回到 Aster：按右上角「＋」→ 選「Telegram」→ 貼上權杖與 Chat ID →「新增並傳送測試」。' },
    ],
    paste: ['Bot 權杖：123456789:AAH…', 'Chat ID：個人是正整數，群組是負數；頻道可填 @頻道名稱（機器人須是該頻道管理員並有「發布訊息」權限）'],
    troubleshoot: [
      { q: 'getUpdates 回傳 {"ok":true,"result":[]}（空的）', a: '你還沒對機器人傳過訊息，或太久沒傳。重新傳一句話，再重新整理那個網址。' },
      { q: '測試顯示 403 沒有權限', a: '你封鎖了機器人，或它被移出群組。到對話按「重新啟動」，或把它加回群組。' },
      { q: '測試顯示 400 chat not found', a: 'Chat ID 貼錯；群組別漏掉負號 -。' },
      { q: '群組裡機器人看不到訊息', a: '不影響通知：Aster 只需要機器人「發送」，不需要它讀取群組訊息。' },
    ],
    links: [
      { label: 'Telegram 官方：建立機器人', url: 'https://core.telegram.org/bots/tutorial' },
      { label: 'Telegram 官方：Bot API', url: 'https://core.telegram.org/bots/api' },
    ],
  },
  line: {
    title: 'LINE：官方帳號 + Messaging API',
    blurb: '收通知最順手（你本來就天天開 LINE），但設定步驟最多，免費額度也有限。',
    facts: [
      '難度：⭐⭐⭐⭐（約 10 分鐘）',
      '費用：免費方案有每月訊息上限。LINE 官方文件的方案表只列日本（免費 200 則）；台灣的「輕用量」方案，依 2023 年改版後的公開報導也是每月 200 則，但我沒有查到 LINE 2026 年的官方公告，請以你帳號的「帳務專區」為準',
      '計算方式（官方）：以「收到訊息的人數」計；主動推送、群發都算，回覆訊息不算；傳給已封鎖官方帳號的人不算。Aster 每則通知 1 則 × 1 個收件人 = 1 則',
      'LINE Notify 已於 2025 年 3 月終止，所以只能用官方帳號的 Messaging API',
    ],
    steps: [
      { text: '用 LINE 帳號登入 LINE Official Account Manager（manager.line.biz），按「建立 LINE 官方帳號」，填名稱（例如 Aster 通知）、業種任選、電子郵件填自己的，選免費的方案後建立。', note: '自 2024 年 9 月起，不能再直接在 LINE Developers Console 建立 Messaging API 頻道，一定要先有官方帳號。' },
      { text: '進入該帳號 →「設定」→「Messaging API」→ 按「啟用 Messaging API」，選一個 Provider（沒有就新建，名稱隨意）。', note: 'Provider 選定後無法更改。啟用成功後，這一頁會顯示「使用中」與 Channel ID、Channel secret，這兩個 Aster 用不到。' },
      { text: '回應設定（同一個「設定」選單）：把「自動回應訊息」和「加入好友的歡迎訊息」關掉，避免機器人自己亂回覆。' },
      { text: '開啟 LINE Developers Console（developers.line.biz/console），用同一個 LINE 帳號登入 → 點你的 Provider → 點剛建立的 Messaging API 頻道。', note: '或按 Official Account Manager「Messaging API」頁面下方的「LINE Developers Console」連結。' },
      { text: '切到「Messaging API」分頁：用你自己的 LINE 掃描上面的 QR Code，把官方帳號加為好友。', note: '沒加好友就收不到訊息，最常被漏掉。' },
      { text: '還在「Messaging API」分頁，往下找「Channel access token（long-lived）」，按「Issue」產生，複製那一長串（通常超過 150 個字元）。', note: '長期權杖不會過期；重新 Issue 會讓舊的失效。官方現在較推薦有期限的 v2.1 權杖，但那需要簽發程式，Aster 用長期權杖最單純。' },
      { text: '切到「Basic settings」分頁，往下找「Your user ID」，複製 U 開頭、共 33 個字元的那串。', note: '畫面名稱可能略有不同；它是「你自己」的 ID，通知會傳給你。' },
      { text: '回到 Aster：按右上角「＋」→ 選「LINE」→ 貼上 Channel access token 與接收對象 ID →「新增並傳送測試」。' },
    ],
    paste: ['Channel access token：一長串英數字（不是 Channel ID，也不是 Channel secret）', '接收對象 ID：U 開頭加 32 碼的「Your user ID」'],
    troubleshoot: [
      { q: '測試顯示 401（權杖錯誤）', a: '貼到 Channel secret 或 Channel ID 了，或權杖前後有空白，或後來又 Issue 過一次讓舊的失效。重新複製。' },
      { q: '測試顯示 403 或收不到', a: '你還沒把官方帳號加為好友，或把它封鎖了。重新掃 QR Code 加好友。' },
      { q: '測試顯示 400', a: '接收對象 ID 貼錯。要貼「Your user ID」（U 開頭），不是 Channel ID。' },
      { q: '之後突然收不到通知', a: '可能當月免費訊息額度用完了，下個月會恢復。到 Official Account Manager 的「帳務專區」看用量；通知多的人建議改用 Telegram 或 Discord，或只讓 LINE 收「預算」「發票中獎」「週報」。' },
      { q: '想傳給家人', a: '對方也要加官方帳號為好友，並取得「他自己的」user ID（Official Account Manager 的聊天功能或 webhook 才能查到，比較麻煩）；家人通常直接用 Discord 或 Telegram 較省事。' },
    ],
    links: [
      { label: 'LINE 官方：Messaging API 入門', url: 'https://developers.line.biz/en/docs/messaging-api/getting-started/' },
      { label: 'LINE 官方：Channel access token 說明', url: 'https://developers.line.biz/en/docs/basics/channel-access-token/' },
      { label: 'LINE 官方：訊息則數與方案', url: 'https://developers.line.biz/en/docs/messaging-api/pricing/' },
      { label: 'LINE Official Account Manager', url: 'https://manager.line.biz' },
    ],
  },
  webhook: {
    title: '自訂 Webhook：接到你自己的服務',
    blurb: '給會寫程式或用 n8n、Make、Home Assistant、IFTTT 這類自動化工具的人。',
    facts: ['難度：⭐⭐⭐（看你的服務）', '費用：看你的服務', '限制：只允許 https、443 埠、公開網域；內網需管理員設定 CLURE_NOTIFY_ALLOW_PRIVATE=true'],
    steps: [
      { text: '在你的服務（n8n 的 Webhook 節點、Make 的 Custom webhook、自己寫的 API…）建立一個「接收 POST 的網址」，必須是 https。' },
      { text: '（建議）設定一個簽章密鑰，例如隨機的 20 個字元，並留著等一下貼進 Aster。' },
      { text: '回到 Aster：按右上角「＋」→ 選「Webhook」→ 貼上網址（與選填的簽章密鑰）→「新增並傳送測試」。' },
      { text: '你的服務會收到 JSON：{ app, event, level, title, body, url, fields:[{name,value}] }。event 是 anomaly、budget、weekly、monthly、reminder、daily、prize 其中之一（測試時是 test）。' },
      { text: '驗證是 Aster 送的：有設密鑰時，請求標頭會有 X-Aster-Signature: sha256=…，值是 HMAC-SHA256（密鑰，請求本文原始位元組）的十六進位。接收端用同樣方式算一次比對即可。', note: '請求本文是 UTF-8 的 JSON、中文不跳脫；驗證時請用「原始本文」，不要先解析再重新序列化。' },
    ],
    paste: ['網址：https://…（不能帶帳號密碼，不能是內網或 localhost）', '簽章密鑰（選填）：任意字串，最長 100 字元'],
    troubleshoot: [
      { q: '新增時顯示「不能連到內網或本機位址」', a: '這是 SSRF 防護：伺服器不允許連到內網。服務在內網（例如 NAS 上的 n8n）時，請管理員在 .env 設定 CLURE_NOTIFY_ALLOW_PRIVATE=true 後重啟，才會允許 http 與內網位址。' },
      { q: '新增時顯示「網域解析不到」', a: '網址打錯，或 NAS 的 DNS 有問題。' },
      { q: '接收端沒有收到', a: 'Aster 不跟隨轉址（301／302）；請填最終網址。通道卡片上會顯示接收端回的狀態碼。' },
    ],
    links: [{ label: '詳細格式與安全設計：docs/NOTIFY.md', url: 'https://github.com/Qiyen1229/clure-aster/blob/main/docs/NOTIFY.md' }],
  },
};
