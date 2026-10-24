// cdp.mjs - zero-dependency headless Chrome over CDP (Node 22+: global fetch + WebSocket), used by
// tests/web_test.mjs to drive web/index.html in a real browser.
//
//   import { serve, launch, withPage } from './cdp.mjs';
//
// Safety: Chrome gets its own fresh profile (zs-cdp-*), is closed with Browser.close, and only
// its own PID tree is ever killed. It never kills Chrome by image name.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- static server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.wasm': 'application/wasm', '.zip': 'application/zip',
};

/** Static server for `dir` on 127.0.0.1:<random>. Returns { base, close() }; base ends with '/'. */
export async function serve(dir) {
  const root = path.resolve(dir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`serve: not a directory: ${root}`);
  const rootLc = root.toLowerCase();
  const server = http.createServer((req, res) => {
    const fail = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method');
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return fail(400, 'bad path'); }
    if (rel.includes('\0')) return fail(400, 'bad path');
    let file = path.resolve(root, rel.replace(/^[/\\]+/, ''));
    const lc = file.toLowerCase();
    if (lc !== rootLc && !lc.startsWith(rootLc + path.sep)) return fail(403, 'outside root');
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); try { st = fs.statSync(file); err = null; } catch (e) { err = e; } }
      if (err || !st.isFile()) return fail(404, 'not found');
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': st.size, 'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  return {
    base, root,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// ---------------------------------------------------------------- chrome
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
function findChrome(p) {
  for (const c of [p, process.env.CHROME_PATH, ...CHROME_CANDIDATES]) if (c && fs.existsSync(c)) return c;
  throw new Error('launch: Chrome not found (pass opts.chrome or set CHROME_PATH)');
}
const portFree = port => new Promise(res => {
  const s = net.createServer();
  s.once('error', () => res(false));
  s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
});
async function freePort() {
  for (let i = 0; i < 60; i++) { const p = 9300 + Math.floor(Math.random() * 600); if (await portFree(p)) return p; }
  throw new Error('launch: no free port in 9300-9899');
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch {} }
}
async function rmProfile(dir) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch {}
    if (!fs.existsSync(dir)) return true;
    await sleep(300);
  }
  process.stderr.write(`[cdp] could not remove profile ${dir} (still locked) - delete it by hand\n`);
  return false;
}

// Emergency cleanup if the host script dies without page.close(): kill only our own PIDs.
const LIVE = new Set();
let hooked = false;
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function syncCleanup() {
  for (const p of LIVE) if (!p._exited) killTree(p.pid);
  for (const p of LIVE) { // dying Chrome children hold profile files for a moment: retry ~3s
    for (let i = 0; i < 15 && fs.existsSync(p.profile); i++) {
      try { fs.rmSync(p.profile, { recursive: true, force: true }); } catch {}
      if (fs.existsSync(p.profile)) sleepSync(200);
    }
    if (fs.existsSync(p.profile)) process.stderr.write(`[cdp] could not remove profile ${p.profile} - delete it by hand\n`);
  }
  LIVE.clear();
}
function hookExit() {
  if (hooked) return; hooked = true;
  process.once('exit', syncCleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.once(sig, () => { syncCleanup(); process.exit(130); }); } catch {}
  }
}

class Conn {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pend = new Map(); this.subs = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (m.id && this.pend.has(m.id)) { const p = this.pend.get(m.id); this.pend.delete(m.id); clearTimeout(p.t); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}${m.error.data ? ' (' + m.error.data + ')' : ''}`)) : p.res(m.result); return; }
      if (m.method) for (const fn of [...(this.subs.get(m.method) || []), ...(this.subs.get('*') || [])]) { try { fn(m.params, m.method); } catch {} }
    };
    ws.onclose = () => { for (const p of this.pend.values()) { clearTimeout(p.t); p.rej(new Error(`${p.method}: CDP socket closed`)); } this.pend.clear(); };
  }
  static open(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.onopen = () => res(new Conn(ws));
      ws.onerror = () => rej(new Error(`CDP websocket failed: ${url}`));
    });
  }
  send(method, params = {}, timeout = 60000) {
    return new Promise((res, rej) => {
      if (this.ws.readyState !== 1) return rej(new Error(`${method}: CDP socket not open`));
      const id = ++this.id;
      const t = setTimeout(() => { this.pend.delete(id); rej(new Error(`${method}: timed out after ${timeout}ms`)); }, timeout);
      this.pend.set(id, { res, rej, t, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { if (!this.subs.has(method)) this.subs.set(method, new Set()); this.subs.get(method).add(fn); return () => this.subs.get(method)?.delete(fn); }
  close() { try { this.ws.close(); } catch {} }
}

/**
 * Launch headless Chrome with a fresh zs-cdp-* profile and attach to its page.
 * opts: { width=1440, height=900, mobile=false, touch=false, dpr=1, chrome, args=[], headless=true,
 *         loadTimeout=30000, profileRoot=os.tmpdir() }
 */
export async function launch(opts = {}) {
  const { width = 1440, height = 900, mobile = false, touch = false, dpr = 1, args = [], headless = true } = opts;
  const chrome = findChrome(opts.chrome);
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(opts.profileRoot || os.tmpdir(), 'zs-cdp-'));
  const argv = [
    ...(headless ? ['--headless=new'] : []),
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--allow-file-access-from-files', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--disable-default-apps', '--mute-audio', '--disable-breakpad',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', `--window-size=${width},${height}`,
    ...args, 'about:blank',
  ];
  const proc = spawn(chrome, argv, { stdio: 'ignore', windowsHide: true });
  const page = { pid: proc.pid, profile, port, chrome, _exited: false };
  let spawnErr = null;
  proc.on('error', e => { spawnErr = e; page._exited = true; });
  proc.on('exit', () => { page._exited = true; });
  LIVE.add(page); hookExit();

  const abort = async msg => { killTree(proc.pid); LIVE.delete(page); await sleep(300); await rmProfile(profile); throw new Error(msg); };
  let ver = null;
  for (const t0 = Date.now(); Date.now() - t0 < 15000 && !ver && !page._exited;) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); }
    catch { await sleep(150); }
  }
  if (!ver) await abort(`launch: Chrome did not expose CDP on port ${port}${spawnErr ? ': ' + spawnErr.message : ''} (deep profile path? TEMP=${os.tmpdir()})`);
  page.version = ver.Browser; page._browserWs = ver.webSocketDebuggerUrl;

  let target = null;
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find(t => t.type === 'page');
    if (!target) target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  } catch (e) { await abort(`launch: no page target: ${e.message}`); }
  let conn;
  try { conn = await Conn.open(target.webSocketDebuggerUrl); } catch (e) { await abort(e.message); }

  // ------------------------------------------------ collectors
  const reqUrl = new Map();
  page.issues = []; page.requests = []; page.warnings = []; page.dialogs = [];
  conn.on('Network.requestWillBeSent', p => { reqUrl.set(p.requestId, p.request.url); page.requests.push(p.request.url); });
  conn.on('Network.responseReceived', p => {
    const r = p.response;
    if (r.status >= 400) page.issues.push({ type: 'http', text: `${r.status} ${r.statusText || ''}`.trim(), url: r.url });
  });
  conn.on('Network.loadingFailed', p => {
    if (p.canceled) return;
    page.issues.push({ type: 'netfail', text: p.errorText + (p.blockedReason ? ` (${p.blockedReason})` : ''), url: reqUrl.get(p.requestId) || '' });
  });
  conn.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails;
    page.issues.push({ type: 'exception', text: d.exception?.description || d.exception?.value || d.text, url: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : '' });
  });
  const argText = a => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.unserializableValue ?? a.type);
  conn.on('Runtime.consoleAPICalled', p => {
    const fr = p.stackTrace?.callFrames?.[0];
    const item = { type: 'console', text: p.args.map(argText).join(' '), url: fr ? `${fr.url}:${fr.lineNumber + 1}` : '' };
    if (p.type === 'error' || p.type === 'assert') page.issues.push(item);
    else if (p.type === 'warning') page.warnings.push({ ...item, type: 'warning' });
  });
  conn.on('Log.entryAdded', ({ entry: e }) => {
    if (e.source === 'network') return; // duplicates the http / netfail entries
    if (e.level === 'error') page.issues.push({ type: 'console', text: `[${e.source}] ${e.text}`, url: e.url || '' });
    else if (e.level === 'warning') page.warnings.push({ type: 'warning', text: `[${e.source}] ${e.text}`, url: e.url || '' });
  });
  conn.on('Page.javascriptDialogOpening', p => {
    page.dialogs.push({ type: p.type, message: p.message });
    conn.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  // ------------------------------------------------ API
  page.send = (method, params = {}, timeout) => conn.send(method, params, timeout);
  page.on = (method, fn) => conn.on(method, fn);
  page.waitFor = (method, pred = null, timeout = 30000) => new Promise((res, rej) => {
    const off = conn.on(method, p => { if (!pred || pred(p)) { clearTimeout(t); off(); res(p); } });
    const t = setTimeout(() => { off(); rej(new Error(`waitFor ${method}: timed out after ${timeout}ms`)); }, timeout);
  });
  page.eval = async (expr, ...fnArgs) => {
    const expression = typeof expr === 'function' ? `(${expr})(${fnArgs.map(a => JSON.stringify(a)).join(',')})` : String(expr);
    const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || (d.exception?.value !== undefined ? String(d.exception.value) : d.text));
    }
    return r.result?.value;
  };
  page.goto = async (url, { waitMs = 1500, timeout = opts.loadTimeout ?? 30000 } = {}) => {
    const loaded = page.waitFor('Page.loadEventFired', null, timeout).then(() => true, () => false);
    const r = await conn.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`goto ${url}: ${r.errorText}`);
    const ok = r.loaderId ? await loaded : true; // same-document navigations fire no load event
    page.url = url; page.lastLoadTimedOut = !ok;
    if (waitMs) await sleep(waitMs);
    return { url, loaded: ok };
  };
  page.viewport = async ({ width: w, height: h, mobile: m = false, touch: t = false, dpr: d = 1 } = {}) => {
    await conn.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: d, mobile: m, screenWidth: w, screenHeight: h });
    await conn.send('Emulation.setTouchEmulationEnabled', t ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await conn.send('Emulation.setEmitTouchEventsForMouse', { enabled: !!t, configuration: m ? 'mobile' : 'desktop' });
    page.size = { width: w, height: h, mobile: m, touch: t, dpr: d };
  };
  page.screenshot = async (file, { fullPage = false, clip, scale = 1 } = {}) => {
    const params = { format: 'png' };
    if (fullPage) {
      const m = await conn.send('Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize, lv = m.cssLayoutViewport || m.layoutViewport;
      params.clip = { x: 0, y: 0, width: Math.max(Math.ceil(cs.width), lv.clientWidth), height: Math.min(Math.ceil(cs.height), 16000), scale };
      params.captureBeyondViewport = true;
    } else if (clip) {
      params.clip = { scale, ...clip }; params.captureBeyondViewport = true;
    } else if (scale !== 1) {
      const vv = (await conn.send('Page.getLayoutMetrics')).cssVisualViewport;
      params.clip = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale };
    }
    const r = await conn.send('Page.captureScreenshot', params, 120000);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  page.thirdParty = origin => {
    let o; try { o = new URL(origin).origin; } catch { o = origin; }
    const skip = /^(data|blob|about|chrome-extension|chrome|chrome-error|devtools):/i;
    const out = new Set();
    for (const u of page.requests) {
      if (skip.test(u)) continue;
      let uo; try { uo = new URL(u).origin; } catch { continue; }
      if (uo !== o) out.add(u);
    }
    return [...out];
  };
  page.clearIssues = () => { page.issues.length = 0; page.warnings.length = 0; page.dialogs.length = 0; };
  page.clearRequests = () => { page.requests.length = 0; };
  let closing = null;
  page.close = () => closing ||= (async () => {
    try {
      const b = await Conn.open(page._browserWs);
      await b.send('Browser.close', {}, 3000).catch(() => {});
      b.close();
    } catch { await conn.send('Browser.close', {}, 3000).catch(() => {}); }
    conn.close();
    for (let i = 0; i < 30 && !page._exited; i++) await sleep(100);
    if (!page._exited) { killTree(proc.pid); for (let i = 0; i < 20 && !page._exited; i++) await sleep(100); }
    LIVE.delete(page);
    await rmProfile(profile);
  })();

  await conn.send('Page.enable');
  await conn.send('Runtime.enable');
  await conn.send('Network.enable');
  await conn.send('Log.enable');
  await page.viewport({ width, height, mobile, touch, dpr });
  return page;
}

/** launch(opts), run fn(page), always close. Returns fn's result. */
export async function withPage(opts, fn) {
  const page = await launch(opts);
  try { return await fn(page); } finally { await page.close(); }
}
