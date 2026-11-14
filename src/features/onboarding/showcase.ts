/**
 * 功能介紹（首次引導的第二步）：只放 Aster 裡「最強大、最新穎」的 6 個功能。
 *
 * 怎麼決定放誰：每個候選功能打兩個分數（1～5）——power＝能替使用者省多少事／做到別的記帳 App 做不到的事，novelty＝新穎程度；
 * score＝power×2＋novelty，取前 SHOWCASE_SIZE 名（同分比 since 較新的、再比登記順序）。
 *
 * 【每次發佈新版本都要做的事】（tests/unit/showcase.test.ts 會擋：版本號改了、release.json 的 showcaseReviewed 沒跟著改，測試就失敗）
 *  1. 這版有沒有新功能？有的話，在下面的 CANDIDATES 新增一筆（power／novelty 照實打分，不要灌水）。
 *  2. 新功能的分數夠高就會自動擠掉第 6 名，不用手動改名單；不夠高就只留在候選裡，下次還有機會。
 *  3. 把 src/release.json 的 showcaseReviewed 改成這個版本，並在 CHANGELOG 該版寫一行「功能介紹：已檢查，…（有／沒有變動）」。
 *  4. 更新後跳出的新功能說明視窗另有一份資料：features/whatsnew/releaseNotes.ts，同一版也要新增一筆（測試會檢查）。
 *  功能被拿掉或大改時，同步修改或移除對應的候選。
 */
import type { IconName } from '@/ui/Icon';

export interface ShowcaseFeature {
  id: string;
  icon: IconName;
  title: string;
  /** 一句話賣點 */
  pitch: string;
  /** 三個重點（要是真的做得到的，不誇大） */
  bullets: [string, string, string];
  /** 怎麼開始用 */
  howto: string;
  /** 這個功能是哪一版推出的 */
  since: string;
  /** 1～5：能替使用者省多少事、做到別的記帳 App 做不到的事 */
  power: number;
  /** 1～5：新穎程度 */
  novelty: number;
}

export const SHOWCASE_SIZE = 6;

export const CANDIDATES: ShowcaseFeature[] = [
  {
    id: 'ai-chat', icon: 'ai', title: 'Cilo 上滑對話', since: '4.1.0', power: 5, novelty: 5,
    pitch: '任何頁面往上滑，直接跟 Aster 說話',
    bullets: ['記帳、查帳、問收支、聊天，都在同一個對話框', '記得這次對話，可以接著問「那上個月呢」', '要改或刪帳目、設預算，先給你預覽，確認才執行'],
    howto: '在底部導覽列往上滑；先到「設定 → Cilo」開啟',
  },
  {
    id: 'agent', icon: 'sliders', title: '一句話整理帳本', since: '4.0.0', power: 5, novelty: 5,
    pitch: '用說的批次整理，先預覽、可以一鍵還原',
    bullets: ['「把上個月 Uber 都歸到交通」「剛剛那筆改成 180」', '最多 8 個步驟一起做：全部成功或全部不動', '執行後整包可還原，刪除的帳目也能救回來'],
    howto: '在 Cilo 對話框直接說出你想整理的事',
  },
  {
    id: 'auto-record', icon: 'wallet', title: '自動記帳', since: '1.3.0', power: 5, novelty: 4,
    pitch: '付款完就記好，不用打開 App',
    bullets: ['Apple Pay 付款後，金額、商家自動送進收件匣', '銀行刷卡簡訊也收得到', '看一眼確認就入帳；訂閱和固定扣款還會提前提醒'],
    howto: '到「收件匣」，一鍵加入 iPhone 捷徑並照步驟設定',
  },
  {
    id: 'schedule', icon: 'clock', title: '排程記帳', since: '4.1.12', power: 4, novelty: 5,
    pitch: '「下週二下午三點半，午餐 200」說一句就排好',
    bullets: ['到時間通知你，可選擇確認後入帳，或直接幫你記', '看得懂後天、三天後、下個月 5 號、月底', '每月房租、訂閱用週期帳目，到期自動處理'],
    howto: '在 Cilo 對話框說出日期與時間，按「排程提醒」',
  },
  {
    id: 'voice', icon: 'mic', title: '語音記帳', since: '1.3.0', power: 4, novelty: 4,
    pitch: '按住說一句話，帳就記好了',
    bullets: ['「昨天晚餐 350 刷玉山卡」，日期、分類、帳戶一次抓出來', '一句話可以記好幾筆', '辨識出文字後用規則解析成帳目，不經過 Cilo'],
    howto: '長按底部導覽列中間的按鈕（iPhone 放開後點麥克風開始說）',
  },
  {
    id: 'photo', icon: 'camera', title: '拍照記帳', since: '2.0.0', power: 4, novelty: 4,
    pitch: '收據、發票拍下來就變成帳目',
    bullets: ['一次最多 8 張，逐張辨識', '每一筆都可以取消勾選，確認後一次記下', '失敗的那張不影響其他張'],
    howto: '在 Cilo 對話框點相機圖示；先到「設定 → Cilo」開啟',
  },
  {
    id: 'fire', icon: 'trend', title: '財務自由與現金流', since: '1.2.0', power: 4, novelty: 3,
    pitch: '看見你的錢未來會怎樣',
    bullets: ['模擬幾歲能退休、每年要存多少', '預測未來 30～180 天的現金流', '直接在對話裡出圖，不用翻頁'],
    howto: '在 Cilo 對話框說「財務自由」或「現金流」',
  },
  {
    id: 'alerts', icon: 'bell', title: '智慧提醒', since: '3.5.0', power: 3, novelty: 4,
    pitch: '幫你盯著不對勁的扣款',
    bullets: ['沒登記的訂閱、漲價、疑似重複扣款', '預算「照目前花法會超支」就先警告', '完全在本機運算'],
    howto: '「設定 → Cilo → 異常提醒」',
  },
  {
    id: 'invest', icon: 'pie', title: '投資組合', since: '1.0.0', power: 4, novelty: 2,
    pitch: '台股、美股的損益一目了然',
    bullets: ['手續費、證交稅自動算', '已實現／未實現損益、XIRR', '股利行事曆與到價提醒'],
    howto: '底部導覽列的「投資」',
  },
  {
    id: 'themes', icon: 'palette', title: '三套完整配色', since: '4.1.29', power: 1, novelty: 2,
    pitch: '背景、卡片與點綴色一次搭配好',
    bullets: ['石墨冰藍、霧白墨綠、暖灰琥珀', '支援深色、淺色與跟隨系統', '經典灰階保留自由選色'],
    howto: '到「設定 → 主題」',
  },
  {
    id: 'pnl-calendar', icon: 'trend', title: '全新盈虧日曆', since: '4.1.30', power: 3, novelty: 4,
    pitch: '首頁一鍵切換，每日股票盈虧一目了然',
    bullets: ['已實現損益與未實現浮動收盤損益自動算', '台股、美股雙幣別自動分行顯示', '點選任一日即可複盤當日持股與交易明細'],
    howto: '在首頁日曆上方點選「盈虧日曆」即可切換',
  },
  {
    id: 'travel-journey', icon: 'compass', title: '旅程時間軸', since: '4.1.35', power: 3, novelty: 4,
    pitch: '旅遊模式把月曆換成逐日明信片，登機證告訴你今天還可花多少',
    bullets: ['每天一張明信片：天數戳章、分類戳章、當日花費，點開直接記這天', '每日額度＝預算÷天數，對比今日已花、超支轉紅', '行前消費標「行前」、返程後自動變旅程回顧'],
    howto: '建立旅遊專案後，首頁右上角切到「旅遊模式」',
  },
  {
    id: 'desktop-home', icon: 'keyboard', title: '電腦寬屏記帳', since: '4.1.38', power: 4, novelty: 3,
    pitch: '寬屏雙欄首頁＋側邊導覽，電腦記帳跟手機一樣順',
    bullets: ['左邊整月月曆＋當日帳目，右邊本月看板，一屏看完', '側邊導覽常駐記一筆／語音／Cilo，鍵盤 N、/、1–5 捷徑', '記帳改置中對話框、Cilo 改右下角面板，不再整屏抽屜'],
    howto: '用電腦瀏覽器開啟 Aster，視窗寬於 1024px 自動切換',
  },
  {
    id: 'swipe-undo', icon: 'trash', title: '左滑刪除可復原', since: '4.1.38', power: 3, novelty: 2,
    pitch: '列表左滑就刪，3 秒內隨時反悔',
    bullets: ['專案、預算、週期、目標、願望、分期、耐用品都適用', '列先收合消失、3 秒後才真正刪除', '通知附倒數條，點「復原」整列回來'],
    howto: '列表列上往左滑超過門檻放開；3 秒內點通知的「復原」',
  },
];

const vParts = (v: string) => v.split('.').map((n) => Number(n) || 0);
export function compareVersion(a: string, b: string): number {
  const [x, y] = [vParts(a), vParts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export const scoreOf = (f: Pick<ShowcaseFeature, 'power' | 'novelty'>) => f.power * 2 + f.novelty;

/** 依分數挑出前 SHOWCASE_SIZE 名（分數相同：較新的版本優先，再比登記順序） */
export function pickShowcase(list: readonly ShowcaseFeature[] = CANDIDATES, size = SHOWCASE_SIZE): ShowcaseFeature[] {
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => scoreOf(b.f) - scoreOf(a.f) || compareVersion(b.f.since, a.f.since) || a.i - b.i)
    .slice(0, size).map((x) => x.f);
}

export const SHOWCASE: ShowcaseFeature[] = pickShowcase();
