/**
 * 前端熱更新建置器（web-builder 容器內執行，Node 20，無額外相依）
 *
 * 1. 監看專案原始碼（輪詢檔案修改時間，NAS 上傳／網路磁碟也偵測得到）
 * 2. 有變更且「靜止」一段時間（上傳完成）後：
 *    - package-lock.json 有變 → 重新安裝套件（npm ci）
 *    - （選用）跑單元測試，失敗就不更新
 *    - vite build 到暫存目錄，成功後整個目錄一次切換為 /srv/www/current（nginx 讀這裡）
 * 3. 建置失敗會保留舊版本繼續服務，並在日誌顯示錯誤；修正檔案後自動重試
 *
 * 環境變數：
 *   POLL_MS          檢查間隔（預設 2000）
 *   SETTLE_MS        最後一次變更後等多久才建置（預設 4000，避免上傳到一半就建置）
 *   RUN_TESTS        true＝建置前先跑單元測試（預設 false）
 *   OUT_DIR          輸出位置（預設 /srv/www）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = process.env.OUT_DIR || '/srv/www';
const POLL_MS = Number(process.env.POLL_MS || 2000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 4000);
const RUN_TESTS = /^(1|true|yes)$/i.test(process.env.RUN_TESTS || '');
const WATCH = ['src', 'public', 'proxy/src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];
const SKIP = new Set(['node_modules', '.git', 'dist']);
const LOCK_HASH_FILE = join(ROOT, 'node_modules', '.clure-lock-hash');

const log = (...a) => console.log(new Date().toLocaleString('zh-TW', { hour12: false }), '[web-builder]', ...a);

/** 所有監看檔案的「路徑＋大小＋修改時間」摘要 */
function signature() {
  const h = createHash('sha1');
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) if (!SKIP.has(name)) walk(join(p, name));
    } else {
      h.update(`${p}:${st.size}:${st.mtimeMs}\n`);
    }
  };
  for (const w of WATCH) walk(join(ROOT, w));
  return h.digest('hex');
}

function fileHash(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return ''; }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  return r.status === 0;
}

function ensureDeps() {
  const want = fileHash(join(ROOT, 'package-lock.json'));
  const have = existsSync(LOCK_HASH_FILE) ? readFileSync(LOCK_HASH_FILE, 'utf8').trim() : '';
  if (want && want === have && existsSync(join(ROOT, 'node_modules', 'vite'))) return true;
  log('安裝前端套件（npm ci）…');
  if (!run('npm', ['ci', '--no-audit', '--no-fund'])) return false;
  writeFileSync(LOCK_HASH_FILE, want);
  return true;
}

function build() {
  const started = Date.now();
  if (!ensureDeps()) { log('❌ 套件安裝失敗，保留目前版本'); return false; }
  if (RUN_TESTS) {
    log('執行單元測試…');
    if (!run('node', ['node_modules/vitest/vitest.mjs', 'run'])) { log('❌ 單元測試失敗，保留目前版本'); return false; }
  }
  const next = join(OUT, '.next');
  rmSync(next, { recursive: true, force: true });
  log('建置中…');
  if (!run('node', ['node_modules/vite/bin/vite.js', 'build', '--outDir', next, '--emptyOutDir'])) {
    log('❌ 建置失敗，保留目前版本（修正檔案後會自動重試）');
    return false;
  }
  // 原子切換：current → .old，.next → current
  const cur = join(OUT, 'current');
  const old = join(OUT, '.old');
  rmSync(old, { recursive: true, force: true });
  if (existsSync(cur)) renameSync(cur, old);
  renameSync(next, cur);
  rmSync(old, { recursive: true, force: true });
  let version = '';
  try { version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch { /* 略過 */ }
  log(`✅ 已上線 v${version}（${((Date.now() - started) / 1000).toFixed(1)} 秒）；使用者開啟 App 時會看到「有新版本」提示`);
  return true;
}

function main() {
  log(`監看 ${WATCH.join('、')}（每 ${POLL_MS / 1000} 秒檢查）`);
  let built = signature();
  const stamp = join(OUT, '.source-signature');
  // 第一次啟動、或容器停止期間覆蓋了檔案 → 立即建置；否則沿用上次的建置結果
  const fresh = existsSync(join(OUT, 'current', 'index.html')) && existsSync(stamp) && readFileSync(stamp, 'utf8') === built;
  if (fresh) log('原始碼沒有變更，沿用上次建置結果');
  else if (build()) writeFileSync(stamp, built);

  let pending = null;
  let changedAt = 0;
  setInterval(() => {
    const sig = signature();
    if (sig !== (pending ?? built)) {
      if (!pending) log('偵測到檔案變更，等待上傳完成…');
      pending = sig;
      changedAt = Date.now();
      return;
    }
    if (pending && Date.now() - changedAt >= SETTLE_MS) {
      const target = pending;
      pending = null;
      // 不論成功與否都記住這個版本，避免失敗時不斷重試同一份檔案；檔案再次變更才會重建
      built = target;
      if (build()) writeFileSync(stamp, target);
    }
  }, POLL_MS);
}

main();
