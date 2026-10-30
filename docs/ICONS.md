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

## 2. App 內的 Logo（底部中央按鈕、載入畫面等）
`src/ui/Icon.tsx` 的 `Logo` 元件，最上面有一個常數：

```ts
const LOGO_OFFSET = { x: 0, y: 0 };
```

和上面一樣，x 正數往右、y 正數往下（1024 畫布上的像素）。改完存檔，開發時會立刻看到；部署時重新打包即可。

載入畫面（開啟 App 的瞬間）用的是 `public/icons/icon-192.png`，它也是由 `npm run icons` 產生的。

## 3. 底部導覽列其他圖示
`src/ui/Icon.tsx` 最上面的 `P`：每個圖示是一條 SVG path（24×24 畫布），可以直接換。大小在 `TabBar.tsx` 的 `<Icon size={20} />`。
