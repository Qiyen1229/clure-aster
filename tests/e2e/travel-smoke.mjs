/**
 * 旅遊模式 headless 冒煙測試（零依賴，Node 22+，需要本機 Chrome）。
 *
 * 用法：
 *   VITE_AUTH_MODE=off npm run build
 *   npm run test:e2e                  # 9122 沒在服務時會自動起 vite preview
 *   SHOT=1 npm run test:e2e           # 另存截圖到 /tmp
 *   CHROME_PATH=/path/to/chrome npm run test:e2e
 *
 * 覆蓋：v4.1.35 旅程時間軸／每日額度框架＋v4.1.36 隔離一致性
 *（帳目明細／搜尋／問句查詢只算這次旅程、範圍提示列可切換回一般模式）。
 * 收件匣隱藏與入帳帶專案屬 auth-on 路徑，由 tests/unit/travel-scope.test.ts 覆蓋。
 * CI：.github/workflows/ci.yml 的 e2e job。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const APP = process.env.APP_URL ?? 'http://localhost:9122';
const SHOT = process.env.SHOT === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
async function appUp() { try { return (await fetch(APP, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }

// ── App：已有服務就用，否則起 vite preview（需先 build） ──
let previewProc = null;
if (!(await appUp())) {
  if (process.env.APP_URL) { console.error(`APP_URL 無法連線：${APP}`); process.exit(1); }
  previewProc = spawn('npx', ['vite', 'preview', '--port', '9122', '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await appUp(); }
  if (!up) { console.error('無法啟動 preview：請先跑 VITE_AUTH_MODE=off npm run build'); previewProc.kill(); process.exit(1); }
}

// ── Chrome headless ──
const CHROME = process.env.CHROME_PATH
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const cdpPort = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'aster-e2e-'));
const chromeArgs = [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--disable-gpu', 'about:blank',
];
if (process.platform === 'linux' || process.env.CI) chromeArgs.push('--no-sandbox', '--disable-dev-shm-usage');
const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch { /* 已結束 */ } try { previewProc?.kill(); } catch { /* 已結束 */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let browserVersion = null;
for (let i = 0; i < 40 && !browserVersion; i++) {
  await sleep(500);
  try { browserVersion = await (await fetch(`http://localhost:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); } catch { /* 等 Chrome 起來 */ }
}
if (!browserVersion) { console.error(`無法啟動 Chrome：${CHROME}（可用 CHROME_PATH 指定）`); process.exit(1); }

// ── CDP ──
const ws = new WebSocket(browserVersion.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let mid = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
};
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++mid;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const { targetInfos } = await send('Target.getTargets');
for (const t of targetInfos) if (t.type === 'page') await send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });

await send('Page.enable', {}, S);
await send('Runtime.enable', {}, S);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);

const consoleErrors = [];
let loadFired = false;
const pump = setInterval(() => {
  while (events.length) {
    const e = events.shift();
    if (e.method === 'Page.loadEventFired') loadFired = true;
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      consoleErrors.push(e.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (e.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(JSON.stringify(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text));
    }
  }
}, 100);

async function navigate(url) {
  loadFired = false;
  await send('Page.navigate', { url }, S);
  const t0 = Date.now();
  while (!loadFired && Date.now() - t0 < 15000) await sleep(50);
  await sleep(1200);
}
async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, S);
  if (r.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function waitFor(selector, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await sleep(250);
  }
  return false;
}
async function shot(name) {
  if (!SHOT) return;
  await evaluate('window.scrollTo(0, 0)');
  await sleep(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, S);
  const path = join(tmpdir(), `aster-e2e-${name}.png`);
  writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('shot:', path);
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const idb = (fn) => evaluate(`(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('clure'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const put = (store, rows) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); for (const row of rows) tx.objectStore(store).put(row); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  const del = (store, keys) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); for (const k of keys) tx.objectStore(store).delete(k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  const out = await (${fn})(put, del);
  db.close(); return out;
})()`, true);

try {
  await navigate(APP + '/');
  const today = new Date();
  const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return dk(d); };
  const seed = { start: addDays(-2), end: addDays(3), today: dk(today), yesterday: addDays(-1), twoDaysAgo: addDays(-2), pre: addDays(-5) };

  const seeded = await idb(`async (put, del) => {
    const seed = ${JSON.stringify(seed)};
    const now = Date.now();
    const base = { createdAt: now, updatedAt: now };
    await del('transactions', ['tx-big', 'tx-home']);
    await put('settings', [
      { key: 'onboarded', value: true },
      { key: 'travelModeProjectId', value: 'proj-okinawa' },
      { key: 'theme', value: 'light' },
      { key: 'themePalette', value: 'default' },
      { key: 'ledgerUnit', value: 'day' },
    ]);
    await put('projects', [{ ...base, id: 'proj-okinawa', name: '沖繩島嶼假期', icon: 'compass', color: '#0e9aa7', start: seed.start, end: seed.end, currency: 'JPY', budgetMinor: 80000, status: 'active', isTravel: true }]);
    await put('accounts', [{ ...base, id: 'acc-cash', name: '現金', icon: '💴', color: '#ffb020', type: 'cash', currency: 'TWD', initialBalanceMinor: 1000000, balanceMinor: 1000000, includeInNetWorth: true, isLiability: false, sort: 0, archived: 0 }]);
    await put('categories', [
      { ...base, id: 'cat-food', kind: 'expense', parentId: '', name: '餐飲', icon: '🍜', color: '#ff6b57', sort: 0, archived: 0 },
      { ...base, id: 'cat-transport', kind: 'expense', parentId: '', name: '交通', icon: '🚕', color: '#0e9aa7', sort: 1, archived: 0 },
      { ...base, id: 'cat-stay', kind: 'expense', parentId: '', name: '住宿', icon: '🏨', color: '#e8467c', sort: 2, archived: 0 },
      { ...base, id: 'cat-shop', kind: 'expense', parentId: '', name: '購物', icon: '🛍️', color: '#ffb020', sort: 3, archived: 0 },
    ]);
    const tx = (id, cat, amt, date, note) => ({ ...base, id, type: 'expense', accountId: 'acc-cash', categoryId: cat, amountMinor: amt, currency: 'JPY', fxRateDec: '0.21', accountAmountMinor: Math.round(amt * 0.21) * 100, baseAmountMinor: Math.round(amt * 0.21) * 100, date, ts: now, note, tagIds: [], attachmentIds: [], projectId: 'proj-okinawa' });
    await put('transactions', [
      tx('tx-0', 'cat-transport', 8000, seed.pre, '機票'),
      tx('tx-1', 'cat-food', 1200, seed.today, '國際通拉麵'),
      tx('tx-2', 'cat-transport', 2300, seed.today, '機場單軌電車'),
      tx('tx-3', 'cat-stay', 14500, seed.yesterday, '海景民宿兩晚'),
      tx('tx-4', 'cat-shop', 9800, seed.twoDaysAgo, '藥妝與伴手禮'),
      // 非旅遊帳目（同日、同關鍵字）：隔離檢查用，不帶 projectId
      { ...base, id: 'tx-home', type: 'expense', accountId: 'acc-cash', categoryId: 'cat-food', amountMinor: 50000, currency: 'TWD', accountAmountMinor: 50000, baseAmountMinor: 50000, date: seed.today, ts: now, note: '家常拉麵', tagIds: [], attachmentIds: [] },
    ]);
    localStorage.setItem('aster.seenVersion', ${JSON.stringify(VERSION)});
    return 'seeded';
  }`);
  check('seed 旅遊資料（含行前機票、非旅遊對照組）', seeded === 'seeded', seeded);

  await navigate(APP + '/');
  check('時間軸渲染', await waitFor('.travel-timeline'));
  const base = await evaluate(`(() => {
    const days = [...document.querySelectorAll('.tt-day')];
    const todayCard = document.querySelector('.tt-day.today');
    const allow = document.querySelector('.travel-allowance');
    return {
      dayCount: days.length,
      preTag: days[0]?.querySelector('.tt-tag.pre')?.textContent ?? null,
      preStamp: days[0]?.querySelector('.tt-stamp')?.textContent ?? null,
      noCalendar: !document.querySelector('.cal-week-strip') && !document.querySelector('.day-head'),
      topbarRange: document.querySelector('.travel-topbar-range')?.textContent ?? null,
      noMonthBtn: !document.querySelector('.month-selector-btn'),
      todayOpen: !!todayCard?.classList.contains('open'),
      todayRows: todayCard?.querySelectorAll('.tt-detail-list > *').length ?? 0,
      addDayBtn: !!todayCard?.querySelector('.tt-detail .btn'),
      allowText: allow?.textContent ?? null,
      allowOver: allow?.classList.contains('over') ?? null,
      allowBarW: document.querySelector('.travel-allowance .bar > i')?.style.width ?? null,
      futureCount: days.filter((d) => d.classList.contains('future')).length,
    };
  })()`);
  check('月曆與當日區塊已移除', base.noCalendar);
  check('頂部改為旅程日期範圍', base.noMonthBtn && !!base.topbarRange, base.topbarRange);
  check('7 張明信片（6 天旅程＋1 行前）', base.dayCount === 7, String(base.dayCount));
  check('行前卡標記與戳章', base.preTag === '行前' && base.preStamp === '✈', `${base.preTag}/${base.preStamp}`);
  check('今天自動展開＋2 筆明細＋記這天', base.todayOpen && base.todayRows === 2 && base.addDayBtn);
  check('每日額度顯示且未超支', !!base.allowText && base.allowText.includes('今天還可花') && base.allowOver === false, base.allowText);
  check('額度條寬度=今日/日均', base.allowBarW === '26%', base.allowBarW);
  check('未來日 3 張', base.futureCount === 3, String(base.futureCount));
  await shot('light');

  // 展開未來日 → 記這天 prefill 日期
  const futureDate = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.tt-day.future')].pop();
    card.querySelector('.tt-card').click();
    return card.querySelector('.tt-date').textContent;
  })()`);
  await sleep(400);
  const futureOpen = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.tt-day.future')].pop();
    const btn = card.querySelector('.tt-detail .btn');
    const empty = !!card.querySelector('.tt-empty');
    btn?.click();
    return { open: card.classList.contains('open'), empty };
  })()`);
  check('未來日展開＋尚未記帳提示', futureOpen.open && futureOpen.empty, futureDate);
  const sheetOk = await waitFor('input[type="date"]');
  const sheetDate = sheetOk ? await evaluate(`document.querySelector('input[type="date"]').value`) : null;
  check('記這天開啟記帳面板', sheetOk, `date=${sheetDate}`);
  await navigate(APP + '/');
  await waitFor('.travel-timeline');

  // 收合今天（等自動展開 effect settle 後再點）
  await sleep(600);
  const collapsed = await evaluate(`(() => {
    const t = document.querySelector('.tt-day.today');
    t.querySelector('.tt-card').click();
    return true;
  })()`);
  await sleep(400);
  const collapsedNow = await evaluate(`!document.querySelector('.tt-day.today').classList.contains('open')`);
  check('點今天可收合', collapsed && collapsedNow);

  // ── v4.1.36 隔離：帳目明細頁 ──
  await navigate(`${APP}/ledger?date=${seed.today}`);
  check('帳目頁：旅遊範圍提示列', await waitFor('.travel-scope-banner'));
  const ledgerScoped = await evaluate(`(() => ({
    banner: document.querySelector('.travel-scope-banner')?.textContent ?? '',
    rows: [...document.querySelectorAll('.tx-row .row-title')].map((e) => e.textContent),
  }))()`);
  check('帳目頁：提示列寫旅程名稱', ledgerScoped.banner.includes('沖繩島嶼假期'), ledgerScoped.banner);
  check('帳目頁：只顯示旅程的 2 筆', ledgerScoped.rows.length === 2 && !ledgerScoped.rows.some((t) => t.includes('家常')), JSON.stringify(ledgerScoped.rows));
  await shot('ledger');
  await evaluate(`document.querySelector('.travel-scope-banner .travel-switch-btn').click()`);
  await sleep(600);
  const ledgerAll = await evaluate(`(() => ({
    banner: !!document.querySelector('.travel-scope-banner'),
    rows: [...document.querySelectorAll('.tx-row .row-title')].map((e) => e.textContent),
  }))()`);
  check('帳目頁：切回一般模式看到全部', !ledgerAll.banner && ledgerAll.rows.length === 3, JSON.stringify(ledgerAll.rows));
  await idb(`async (put) => { await put('settings', [{ key: 'travelModeProjectId', value: 'proj-okinawa' }]); return 'travel-on'; }`);

  // ── v4.1.36 隔離：搜尋頁 ──
  await navigate(`${APP}/search?q=${encodeURIComponent('拉麵')}`);
  check('搜尋頁：旅遊範圍提示列', await waitFor('.travel-scope-banner'));
  await waitFor('.tx-row');
  const searchScoped = await evaluate(`[...document.querySelectorAll('.tx-row .row-title')].map((e) => e.textContent)`);
  check('搜尋頁：只搜得到旅程帳目', searchScoped.length === 1 && searchScoped[0].includes('國際通'), JSON.stringify(searchScoped));
  await shot('search');

  // ── v4.1.36 隔離：問句查詢 ──
  await navigate(`${APP}/search?q=${encodeURIComponent('今天花多少')}`);
  const ansOk = await waitFor('.ask-answer');
  const ans = ansOk ? await evaluate(`document.querySelector('.ask-answer .ask-text')?.textContent ?? ''`) : '';
  // 旅程今日 3500 JPY ≈ NT$735；含非旅遊的家常拉麵會是 NT$1,235
  check('問句：只計旅程支出', ansOk && ans.includes('735') && !ans.includes('1,235'), ans);

  // 超支情境：今日再加 12000 → 15500 > 13333
  await idb(`async (put) => {
    const now = Date.now();
    await put('transactions', [{ createdAt: now, updatedAt: now, id: 'tx-big', type: 'expense', accountId: 'acc-cash', categoryId: 'cat-shop', amountMinor: 12000, currency: 'JPY', fxRateDec: '0.21', accountAmountMinor: 252000, baseAmountMinor: 252000, date: '${seed.today}', ts: now, note: '免稅店家電', tagIds: [], attachmentIds: [], projectId: 'proj-okinawa' }]);
    return 'big-added';
  }`);
  await navigate(APP + '/');
  await waitFor('.travel-allowance');
  const over = await evaluate(`(() => {
    const a = document.querySelector('.travel-allowance');
    return { over: a.classList.contains('over'), text: a.textContent, barW: a.querySelector('.bar > i').style.width };
  })()`);
  check('超支轉紅＋今日超支文案', over.over && over.text.includes('今日超支') && over.barW === '100%', JSON.stringify(over));

  // 深色夜航
  await idb(`async (put) => { await put('settings', [{ key: 'theme', value: 'dark' }]); return 'dark'; }`);
  await navigate(APP + '/');
  await waitFor('.travel-timeline');
  await sleep(600);
  const dark = await evaluate(`(() => {
    const cs = (sel, p) => getComputedStyle(document.querySelector(sel))[p];
    return { theme: document.documentElement.dataset.theme, cardBg: cs('.tt-card', 'backgroundColor') };
  })()`);
  check('夜航深色時間軸', dark.theme === 'dark' && dark.cardBg === 'rgb(38, 32, 56)', JSON.stringify(dark));
  await shot('dark');

  // 返程後：回顧三格＋日均花費
  await idb(`async (put) => {
    const now = Date.now();
    await put('projects', [{ createdAt: now, updatedAt: now, id: 'proj-okinawa', name: '沖繩島嶼假期', icon: 'compass', color: '#0e9aa7', start: '${seed.start}', end: '${seed.yesterday}', currency: 'JPY', budgetMinor: 80000, status: 'active', isTravel: true }]);
    return 'ended';
  }`);
  await navigate(APP + '/');
  await waitFor('.tt-recap');
  const recap = await evaluate(`(() => ({
    head: document.querySelector('.travel-timeline-head h3').textContent,
    cells: [...document.querySelectorAll('.tt-recap-cell')].map((c) => c.textContent),
    allow: document.querySelector('.travel-allowance')?.textContent ?? null,
  }))()`);
  check('返程後變旅程回顧', recap.head === '旅程回顧' && recap.cells.length === 3, JSON.stringify(recap.cells));
  check('回顧後額度改日均花費', (recap.allow || '').includes('日均花費'), recap.allow);
  await shot('after');

  // 還原旅程中＋淺色 → 桌面
  await idb(`async (put) => {
    const now = Date.now();
    await put('settings', [{ key: 'theme', value: 'light' }]);
    await put('projects', [{ createdAt: now, updatedAt: now, id: 'proj-okinawa', name: '沖繩島嶼假期', icon: 'compass', color: '#0e9aa7', start: '${seed.start}', end: '${seed.end}', currency: 'JPY', budgetMinor: 80000, status: 'active', isTravel: true }]);
    return 'restored';
  }`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, S);
  await navigate(APP + '/');
  await waitFor('.travel-timeline');
  await sleep(600);
  const desk = await evaluate(`(() => {
    const t = document.querySelector('.travel-timeline').getBoundingClientRect();
    return { w: t.width, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  check('桌面：時間軸限寬無橫溢', desk.w <= 720 && !desk.overflow, JSON.stringify(desk));
  await shot('desktop');

  // reduced-motion
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, S);
  await sleep(300);
  const rm = await evaluate(`getComputedStyle(document.querySelector('.tt-chev')).transitionDuration`);
  check('減少動態：收合箭頭無動畫', rm === '0s' || rm === '0.001s', rm);

  const realErrors = consoleErrors.filter((e) => !/favicon|sync|fetch|network|404|ERR_/i.test(e));
  check('無 runtime console 錯誤', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
  clearInterval(pump);
  ws.close();
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);