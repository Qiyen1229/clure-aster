/**
 * 新功能發佈資訊（單一來源：src/release.json）。
 * - featureRelease：目前「最新一批新功能」是哪一版推出的。只有這一批的 <NewMark since="…" /> 會亮；下次有新功能時把它改成新版本，
 *   舊功能的閃光符號就會自動全部熄掉。小修正不要改它。
 * - headline：更新提示與「有新功能可用」通知裡的一句話。
 * 建置時會另外輸出 /release.json（含 version），舊版 App 偵測到新版本時用它判斷「這次更新有沒有新功能」。
 */
import rel from './release.json';

export const FEATURE_RELEASE: string = rel.featureRelease;
export const FEATURE_HEADLINE: string = rel.headline;
