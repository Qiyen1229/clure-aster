# Aster 報價代理（CORS Proxy）

瀏覽器不能直接呼叫證交所、櫃買、Yahoo 等沒有開放 CORS 的 API，因此需要一個極輕量的代理。
同一份核心程式（`src/core.ts`）可部署成三種形式：

| 形式 | 適用 | 前端「代理網址」 |
|---|---|---|
| NAS Docker（`quote-proxy` 容器） | 自架 NAS | `/proxy`（預設，經 nginx 同源轉發） |
| Cloudflare Workers | 部署在 Cloudflare Pages／GitHub Pages 等靜態主機 | `https://clure-quote-proxy.<你的帳號>.workers.dev` |
| Vite 開發伺服器（內建） | `npm run dev`／`npm run preview` | `/proxy`（預設） |

安全設計：只允許白名單網域（`ALLOWED_HOSTS`）、只允許 GET、每 IP 每分鐘 120 次、可選 `ACCESS_TOKEN`、不記錄請求內容。

## A. NAS Docker
專案根目錄的 `docker-compose.yml` 已包含 `quote-proxy` 服務，`docker compose up -d --build` 即會一起啟動。
若要設定權杖：在 `.env` 填 `PROXY_ACCESS_TOKEN=一串亂碼`，並在 App「設定 → 股票資料源 → 代理權杖」填同樣的值。

## B. Cloudflare Workers（免費方案即可）
1. 安裝 Node.js 20+，註冊 Cloudflare 帳號。
2. 在 `proxy/` 目錄執行：
   ```bash
   npx wrangler login
   ```
   ```bash
   npx wrangler deploy
   ```
3. （建議）設定權杖：
   ```bash
   npx wrangler secret put ACCESS_TOKEN
   ```
4. 部署完成會顯示網址，例如 `https://clure-quote-proxy.yourname.workers.dev`。
5. App →「設定 → 股票資料源」：代理網址填上述網址、代理權杖填第 3 步的值，按「測試連線」。

## C. Vercel Edge Function（替代方案）
新增 `api/proxy.ts`：
```ts
import { handle } from '../proxy/src/core';
export const config = { runtime: 'edge' };
export default (req: Request) => handle(req, { ACCESS_TOKEN: process.env.ACCESS_TOKEN }, { basePath: '/api/proxy' });
```
代理網址填 `https://<你的專案>.vercel.app/api/proxy`。
