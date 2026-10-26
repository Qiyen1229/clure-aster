// 產生所有 PWA / iOS 圖標與啟動畫面：node scripts/gen-icons.mjs
// 來源：assets/icon.svg（1024x1024 滿版）。需要 devDependency「sharp」。
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
// 回傳檔案系統路徑（不用 URL.pathname，路徑含空白或中文時會被編碼而找不到）
const out = (p) => fileURLToPath(new URL(`public/${p}`, root));
await mkdir(out('icons'), { recursive: true });
await mkdir(out('splash'), { recursive: true });

const icon = await readFile(new URL('assets/icon.svg', root));

// 1) 一般圖標
const sizes = [
  ['icons/icon-192.png', 192],
  ['icons/icon-512.png', 512],
  ['icons/maskable-512.png', 512], // 內容已在 80% 安全區內，可直接當 maskable
  ['icons/apple-touch-icon.png', 180],
  ['icons/favicon-32.png', 32],
];
for (const [file, size] of sizes) {
  await sharp(icon, { density: 384 }).resize(size, size).png().toFile(out(file));
}
for (const name of ['shortcut-add', 'shortcut-invest']) {
  const svg = await readFile(new URL(`assets/${name}.svg`, root));
  await sharp(svg, { density: 384 }).resize(96, 96).png().toFile(out(`icons/${name}.png`));
}
// 圓角 SVG favicon（瀏覽器分頁用）
const rounded = icon.toString().replace('<rect width="1024" height="1024" fill="url(#bg)"/>',
  '<rect width="1024" height="1024" rx="224" fill="url(#bg)"/>').replace('<rect width="1024" height="1024" fill="url(#glow)"/>',
  '<rect width="1024" height="1024" rx="224" fill="url(#glow)"/>');
await writeFile(out('icons/favicon.svg'), rounded);

// 2) iOS 啟動畫面（apple-touch-startup-image）— [CSS 寬, CSS 高, DPR]
export const devices = [
  [440, 956, 3], [430, 932, 3], [420, 912, 3], [402, 874, 3], [393, 852, 3], [390, 844, 3],
  [428, 926, 3], [375, 812, 3], [414, 896, 3], [414, 896, 2], [375, 667, 2],
  [1032, 1376, 2], [1024, 1366, 2], [834, 1210, 2], [834, 1194, 2], [820, 1180, 2], [768, 1024, 2], [744, 1133, 2],
];
const links = [];
for (const [w, h, dpr] of devices) {
  const W = w * dpr, H = h * dpr, logo = Math.round(Math.min(W, H) * 0.28);
  const logoPng = await sharp(icon, { density: 384 }).resize(logo, logo)
    .composite([{ input: Buffer.from(`<svg width="${logo}" height="${logo}"><rect width="${logo}" height="${logo}" rx="${logo * 0.22}"/></svg>`), blend: 'dest-in' }])
    .png().toBuffer();
  const file = `splash/splash-${W}x${H}.png`;
  await sharp({ create: { width: W, height: H, channels: 4, background: '#000000' } })
    .composite([{ input: logoPng, gravity: 'center' }]).png({ compressionLevel: 9 }).toFile(out(file));
  links.push(`<link rel="apple-touch-startup-image" href="/${file}" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)">`);
}
console.log('✅ 圖標與啟動畫面已輸出到 public/。index.html 對應的 <link>：\n' + links.join('\n'));
