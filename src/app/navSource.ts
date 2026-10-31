/**
 * 記錄「這次換頁是不是靈動島（底部導覽列）發起的」。
 * 只有靈動島切換分頁時，整個頁面才會帶 Q 彈的彈簧轉場；一般跳頁、進設定、返回都維持普通的滑入。
 */
let dockAt = -Infinity;
export const markDockNav = () => { dockAt = performance.now(); };
/** 靈動島發起後的 1 秒內，新的路徑變化都算是靈動島造成的 */
export const isDockNav = () => performance.now() - dockAt < 1000;
