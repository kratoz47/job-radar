import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readlinkSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PLATFORMS, platformById } from './platforms.mjs';
import { chromium } from './pw.mjs';

const ROOT = join(import.meta.dirname, '..');
const BROWSER_DIR = join(ROOT, 'data', 'browser');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const profileDir = (id) => join(BROWSER_DIR, id);
const pidFile = (id) => join(BROWSER_DIR, `${id}.pid`);
const logFile = (id) => join(BROWSER_DIR, `${id}.log`);
const lockPath = (id) => join(profileDir(id), 'SingletonLock');

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// SingletonLock 是个符号链接：hostname-<pid>
function chromePid(id) {
  try {
    const target = readlinkSync(lockPath(id));
    const m = target.match(/-(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

export function readPid(id) {
  try {
    const pid = Number(readFileSync(pidFile(id), 'utf8').trim());
    return alive(pid) ? pid : null;
  } catch { return null; }
}

function cookieDbPaths(id) {
  const dir = join(profileDir(id), 'Default');
  // 新版 Chromium 在 Default/Network/Cookies，旧版在 Default/Cookies
  return [join(dir, 'Network', 'Cookies'), join(dir, 'Cookies')];
}

export function loginCookieNames(id) {
  const cfg = platformById(id);
  for (const dbPath of cookieDbPaths(id)) {
    if (!existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      // expires_utc 是 1601 起的微秒；0 表示 session cookie
      const nowWebKit = (Date.now() + 11644473600000) * 1000;
      const rows = db.prepare('SELECT name FROM cookies WHERE host_key LIKE ? AND (expires_utc = 0 OR expires_utc > ?)')
        .all(`%${cfg.host}%`, nowWebKit);
      db.close();
      const names = [...new Set(rows.map(r => r.name))];
      if (names.length) return names;
    } catch { /* try next */ }
  }
  return [];
}

export function status(id) {
  const cfg = platformById(id);
  if (!cfg) return null;
  const cookies = loginCookieNames(id);
  const loggedIn = cookies.some(n => cfg.loginCookies.includes(n));
  const cpid = chromePid(id);
  return {
    id, name: cfg.name, scan: cfg.scan, paid: !!cfg.paid, external: !!cfg.external, loginUrl: cfg.loginUrl,
    browserOpen: alive(cpid),
    chromePid: alive(cpid) ? cpid : null,
    profileExists: existsSync(profileDir(id)),
    loggedIn,
    cookieHints: cookies.filter(n => cfg.loginCookies.includes(n)),
    loginNote: cfg.loginNote || '',
    payNote: cfg.payNote || '',
  };
}

export function allStatus() {
  return PLATFORMS.map(p => status(p.id));
}

function cleanupLocks(id) {
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { unlinkSync(join(profileDir(id), f)); } catch { /* ignore */ }
  }
}

function logTail(id, bytes = 4000) {
  try {
    const p = logFile(id);
    const size = statSync(p).size;
    const start = Math.max(0, size - bytes);
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

function profilePids(id) {
  try {
    const out = execFileSync('pgrep', ['-f', `--user-data-dir=${profileDir(id)}`], { encoding: 'utf8' });
    return out.split('\n').map(Number).filter(Boolean);
  } catch { return []; }
}

function signal(pid, sig) {
  if (!pid) return;
  try { process.kill(pid, sig); } catch { /* ignore */ }
}

// 直接用原生 Chrome 启动登录窗口：不连 CDP，BOSS 不会把页面导到 about:blank
export function chromeExe() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { return chromium.executablePath(); } catch { return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; }
}

async function launch(id) {
  const cfg = platformById(id);
  const log = openSync(logFile(id), 'a');
  const child = spawn(chromeExe(), [
    '--no-sandbox', '--disable-gpu',
    `--user-data-dir=${profileDir(id)}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', '--window-position=80,60',
    '--disable-blink-features=AutomationControlled',
    cfg.loginUrl,
  ], {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: ROOT,
  });
  child.unref();
  writeFileSync(pidFile(id), String(child.pid));
  closeSync(log);

  // 等 Chrome 进程把 SingletonLock 建出来
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const cpid = chromePid(id);
    if (alive(cpid)) return child.pid;
  }
  return null;
}

export async function openLogin(id) {
  const cfg = platformById(id);
  if (!cfg) throw new Error('未知平台');
  mkdirSync(profileDir(id), { recursive: true });

  // 已有活着的 Chrome：不再启动第二个（否则 Chrome 会把 URL 转给旧实例后自行退出）
  const existing = chromePid(id);
  if (alive(existing)) {
    return { ...status(id), alreadyOpen: true };
  }

  // 锁丢了但 Chrome 还活着：先杀掉，否则新窗口会被转发给旧实例后退出
  for (const pid of profilePids(id)) signal(pid, 'SIGKILL');
  cleanupLocks(id);
  try { unlinkSync(pidFile(id)); } catch { /* ignore */ }

  let pid = await launch(id);
  if (!pid) {
    const tail = logTail(id);
    if (/现有的浏览器会话/.test(tail)) {
      // 旧实例残留：杀掉同 profile 的进程，再清锁重试
      for (const p of profilePids(id)) signal(p, 'SIGKILL');
      await sleep(800);
      cleanupLocks(id);
      try { unlinkSync(pidFile(id)); } catch { /* ignore */ }
      pid = await launch(id);
    }
    if (!pid) {
      cleanupLocks(id);
      throw new Error('浏览器启动失败（可查看 data/browser/' + id + '.log）：' + (logTail(id).split('\n').filter(Boolean).slice(-3).join(' | ') || '未知错误'));
    }
  }

  await sleep(600);
  return status(id);
}

// 扫描窗口：带扩展启动，全程不连 CDP
export async function openScanWindow(id, extensionDir, startUrl = 'about:blank') {
  mkdirSync(profileDir(id), { recursive: true });
  const existing = chromePid(id);
  if (alive(existing)) throw new Error('登录窗口还开着，先关掉');
  cleanupLocks(id);
  const log = openSync(logFile(id), 'a');
  const child = spawn(chromeExe(), [
    '--no-sandbox', '--disable-gpu',
    `--user-data-dir=${profileDir(id)}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', '--window-position=-2400,0',
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    startUrl,
  ], { detached: true, stdio: ['ignore', log, log], cwd: ROOT });
  child.unref();
  writeFileSync(pidFile(id), String(child.pid));
  closeSync(log);
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    if (alive(chromePid(id))) return child.pid;
  }
  throw new Error('扫描浏览器启动失败，见 data/browser/' + id + '.log');
}

export async function closeLogin(id) {
  const cpid = chromePid(id);
  const npid = readPid(id);
  // 先温柔退出：Chrome 收到 SIGTERM 会把 Cookie 落盘；SIGKILL 会丢登录态
  signal(cpid, 'SIGTERM');
  signal(npid, 'SIGTERM');
  for (let i = 0; i < 40; i++) {           // 最多等 10 秒
    if (!alive(cpid)) break;
    await sleep(250);
  }
  if (alive(cpid)) signal(cpid, 'SIGKILL'); // 还不退才强杀，可能丢 Cookie
  await sleep(300);
  cleanupLocks(id);
  try { unlinkSync(pidFile(id)); } catch { /* ignore */ }
  return status(id);
}
