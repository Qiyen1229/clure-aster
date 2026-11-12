# 自己調整圖標

## 1. iOS 主畫面圖標（以及 App 圖標、啟動畫面、分頁小圖示）
來源只有一個：`assets/icon.svg`（1024×1024）。

1. 打開 `assets/icon.svg`，找到 `<g id="art" transform="translate(30 30)">`。
2. 改 `translate(X Y)` 的兩個數字：**X 正數＝往右、負數＝往左；Y 正數＝往下、負數＝往上**，單位是 1024 畫布上的像素（30 約是 3%）。想再靠右下一點就加大，想回正中間就改成 `translate(0 0)`。
3. 重新產生所有圖標：
   ```bash
   npm run icons
   ```
4. 看一下 `public/icons/icon-512.png` 確認位置，再打包部署。
5. iPhone 會快取主畫面圖標：**先刪掉主畫面上舊的 Aster，再用 Safari 重新「加入主畫面」**。`index.html` 裡的 `?v=版本號` 會跟著版本更新來避開快取（改圖標後記得升版本號）。

想換顏色、粗細或圖案，也是直接改這個 SVG（漸層在最上面的 `<defs>`）。

## 2. App 內的品牌標記（底部中央按鈕）
沒有獨立 Logo 元件：`TabBar.tsx` 直接渲染 `<Icon name="brand" size={26} stroke={2} className="brand" />`——極簡花體 A（來源 `assets/brand-a-icons/script-a-pure.svg`：三道圓頭筆鋒＋頂峰星點），與全 App 圖示同一套 24×24 線條語言，顏色以 currentColor 跟隨主題。

- 大小：`src/theme/app.css` 的 `.fab-layer .brand`（目前 26px）。
- 顏色：`.dynamic-fab.mode-logo` 的 `color: var(--accent)`，自動跟隨主題與深淺色。
- 花體 A 幾何：`src/ui/Icon.tsx` 的 `ICON_NODES.brand`（主筆 2、橫槓 1.8、頂峰 0.9 實心星點）。

載入畫面（開啟 App 的瞬間）用的是 `public/splash/` 啟動畫面與 `public/icons/icon-192.png`，也都由 `npm run icons` 產生。

## 3. 底部導覽列其他圖示
`src/ui/Icon.tsx` 最上面的 `ICON_NODES`：每個圖示是 SVG path（24×24 畫布），可以直接換。大小在 `TabBar.tsx` 的 `<Icon size={20} />`。