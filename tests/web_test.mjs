// Drives web/index.html in headless Chrome against tests/dev_server.py (the real gatekeeper in
// front of the mock Ollama), one fresh browser profile and one fresh server per scenario.
//
//   node tests/web_test.mjs                    # every scenario
//   node tests/web_test.mjs --only 2,5,13      # just these
//   node tests/web_test.mjs --shots DIR        # also save screenshots into DIR
//   node tests/web_test.mjs --list
//
// Needs Node 22+, Python 3.10+ and Chrome or Edge. Nothing to install: it uses the zero-dependency
// CDP helper tests/cdp.mjs (set CDP_MJS to use another copy).
// Set PYTHON if "python" isn't the right command. Exit code 1 when any scenario fails.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP = process.env.CDP_MJS || path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp.mjs');
const PYTHON = process.env.PYTHON || 'python';
const { serve, launch } = await import(pathToFileURL(CDP).href);

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const SHOTS = opt('--shots') ? path.resolve(opt('--shots')) : null;
const ONLY = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ngla-web-'));

// ------------------------------------------------------------------ the dev server

const SERVERS = new Set();
let serverCount = 0;
process.on('exit', () => { for (const s of SERVERS) try { s.proc.kill(); } catch {} }); // only our own PIDs

async function startServer(flags = [], { key } = {}) {
  key ||= 'key-' + Math.random().toString(36).slice(2, 10);
  const log = path.join(TMP, `requests-${++serverCount}.jsonl`);
  const proc = spawn(PYTHON, [path.join(REPO, 'tests', 'dev_server.py'), '--port', '0', '--key', key, '--log-requests', log, ...flags],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  const srv = { proc, key, log, out: '', err: '', exited: false, code: null };
  srv.exit = new Promise((resolve) => proc.on('exit', (code) => { srv.exited = true; srv.code = code; SERVERS.delete(srv); resolve(code); }));
  proc.on('error', (e) => { srv.err += String(e); });
  proc.stdout.on('data', (d) => { srv.out += d; });
  proc.stderr.on('data', (d) => { srv.err += d; });
  SERVERS.add(srv);
  srv.requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).body) : []);
  srv.stop = async () => {
    if (srv.exited) return;
    try { await fetch(srv.url + '/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + srv.key }, signal: AbortSignal.timeout(3000) }); } catch {}
    if (await Promise.race([srv.exit.then(() => true), sleep(4000).then(() => false)])) return;
    try { proc.kill(); } catch {}
    await Promise.race([srv.exit, sleep(3000)]);
  };
  for (const t0 = Date.now(); !/^Open: \S+/m.test(srv.out);) {
    if (srv.exited) throw new Error(`dev_server exited early: ${srv.err.trim().slice(-300)}`);
    if (Date.now() - t0 > 15000) { srv.url ||= 'http://127.0.0.1:1'; try { proc.kill(); } catch {} throw new Error('dev_server printed no address in 15 s'); }
    await sleep(40);
  }
  const first = srv.out.match(/^Mock server: (http:\/\/127\.0\.0\.1:\d+)\s+key: (\S+)/m);
  if (!first) throw new Error(`unexpected dev_server output: ${srv.out.slice(0, 200)}`);
  srv.url = first[1];
  srv.link = srv.out.match(/^Open: (\S+)/m)[1];
  srv.fragment = srv.link.slice(srv.link.indexOf('#'));
  return srv;
}

// ------------------------------------------------------------------ in-page hooks (installed before the page's own script)

// Captures blobs and downloads instead of saving files, keeps the real clipboard untouched, and
// records long tasks. Exposed as window.__t.
function hooks() {
  const T = (window.__t = { blobs: [], downloads: [], copied: [], longest: 0 });
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj) => { const url = create(obj); T.blobs.push({ url, blob: obj, type: obj?.type, size: obj?.size }); return url; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) { T.downloads.push({ name: this.getAttribute('download'), href: this.href }); return; }
    return click.call(this);
  };
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { T.copied.push(String(t)); } } }); } catch {}
  const exec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (cmd, ...rest) {
    if (String(cmd).toLowerCase() === 'copy') { const a = document.activeElement; T.copied.push(a && 'value' in a ? a.value : String(getSelection())); return true; }
    return exec.call(this, cmd, ...rest);
  };
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) T.longest = Math.max(T.longest, e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
  T.visible = (n) => {
    if (typeof n === 'string') n = document.querySelector(n);
    if (!n) return false;
    const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };
  T.text = (sel) => (document.querySelector(sel)?.textContent || '').trim();
  T.blobText = (i = -1) => T.blobs.at(i).blob.text();
  T.idb = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('no-gpu-local-ai', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('chats', { keyPath: 'id' });
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result, get = db.transaction('chats', 'readonly').objectStore('chats').getAll();
      get.onsuccess = () => { db.close(); resolve(get.result); };
      get.onerror = () => reject(get.error);
    };
  });
  T.lastReply = () => {
    const m = document.querySelector('#thread > .msg.assistant:last-child');
    if (!m) return null;
    const prose = m.querySelector('.prose');
    const placeholder = prose.querySelector(':scope > span.cursor') && !prose.querySelector(':scope > :not(span.cursor)');
    return {
      id: m.dataset.message, done: Boolean(m.querySelector('.msg-foot')), text: placeholder ? '' : prose.textContent,
      readings: m.querySelector('.readings')?.textContent || '', error: m.querySelector('.msg-error')?.textContent || '',
      trace: Boolean(m.querySelector('.trace')), traceLive: Boolean(m.querySelector('.trace.live')),
      traceText: m.querySelector('.trace-body')?.textContent || '', traceTitle: m.querySelector('.trace-title')?.textContent || '',
    };
  };
}

// Makes the page's 30-second status poll fire after 1.5 s, so a test can see what a poll does.
function fastPoll() {
  const st = window.setTimeout;
  window.setTimeout = (fn, ms, ...rest) => st(fn, ms === 30000 ? 1500 : ms, ...rest);
}

// ------------------------------------------------------------------ browser helpers

async function browser(ctx, { width = 1440, height = 900, mobile = false, touch = false, colorScheme, poll = false } = {}) {
  const page = await launch({ width, height, mobile, touch });
  ctx.pages.push(page);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${hooks})();` });
  if (poll) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${fastPoll})();` });
  if (colorScheme) await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
  return page;
}

let PAGE = ''; // http://127.0.0.1:<port>/index.html, set in main

const linkFor = (srv, key = srv.key) => `${PAGE}#server=${encodeURIComponent(srv.url)}&key=${encodeURIComponent(key)}`;

async function until(page, fn, args = [], { timeout = 10000, every = 40, what = 'the page' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await page.eval(fn, ...args);
    if (last) return last;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(every);
  }
}

const statusText = (page) => page.eval(() => document.getElementById('status-text').textContent);

async function waitStatus(page, want, timeout = 10000) {
  try {
    return await until(page, (w) => document.getElementById('status-text').textContent === w, [want], { timeout, what: `status "${want}"` });
  } catch { throw new Error(`status is "${await statusText(page)}", expected "${want}"`); }
}

async function openApp(page, srv, { key, ready = true } = {}) {
  await page.goto(linkFor(srv, key), { waitMs: 100 });
  if (ready) await waitStatus(page, 'Ready');
}

async function reload(page) {
  const loaded = page.waitFor('Page.loadEventFired', null, 30000);
  await page.send('Page.reload', { ignoreCache: true });
  await loaded;
  await sleep(100);
}

/** A real mouse (or, with touch emulation, a tap) at the element's centre; fails when something covers it. */
async function tap(page, sel) {
  const r = await page.eval((s) => {
    const n = document.querySelector(s);
    if (!n) return { missing: true };
    n.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = n.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: b.width, h: b.height, ok: Boolean(hit && (hit === n || n.contains(hit))), hit: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ').join('.') : '') : 'nothing' };
  }, sel);
  if (r.missing) throw new Error(`no element matches ${sel}`);
  if (!r.w || !r.h) throw new Error(`${sel} isn't displayed`);
  if (!r.ok) throw new Error(`${sel} is covered by ${r.hit}`);
  await tapAt(page, r.x, r.y);
}

async function tapAt(page, x, y) {
  if (page.size?.touch) { // a finger: touch start + end, which the page sees as a tap and a click
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(30);
    return;
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Focuses the field, selects what's there and types over it (fires real input events). */
async function type(page, sel, text) {
  const found = await page.eval((s) => { const n = document.querySelector(s); if (!n) return false; n.focus(); n.select?.(); return true; }, sel);
  if (!found) throw new Error(`no element matches ${sel}`);
  await page.send('Input.insertText', { text });
}

async function ask(page, text, { timeout = 15000 } = {}) {
  const before = await page.eval(() => window.__t.lastReply()?.id || null);
  await type(page, '#input', text);
  await tap(page, '#send');
  return waitReply(page, before, timeout);
}

async function waitReply(page, before, timeout = 15000) {
  return until(page, (prev) => {
    const r = window.__t.lastReply();
    const send = document.getElementById('send');
    if (!r || r.id === prev || !r.done || send.getAttribute('aria-label') !== 'Send' || document.querySelector('.chat-item.live')) return null;
    return r;
  }, [before], { timeout, what: 'the reply to finish' });
}

async function shot(page, name) {
  if (!SHOTS) return;
  await sleep(250); // let transitions settle
  await page.screenshot(path.join(SHOTS, name));
}

/** Elements under `rootSel` that stick out of the viewport sideways without a scrolling box to hold them. */
function escapes(rootSel) {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const root of document.querySelectorAll(rootSel)) {
    for (const n of root.querySelectorAll('*')) {
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height || (r.right <= vw + 1 && r.left >= -1)) continue;
      let p = n.parentElement, held = false;
      while (p && p !== root.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') { held = true; break; }
        p = p.parentElement;
      }
      if (!held) out.push(`${n.tagName.toLowerCase()}.${String(n.className).split(' ').join('.')} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
  }
  return out.slice(0, 8);
}

function assert(cond, message) { if (!cond) throw new Error(message); }
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, expected ${e}`);
}

const CODE = [
  'from pathlib import Path',
  '',
  'def rename_by_date(folder):',
  '    for path in sorted(Path(folder).iterdir()):',
  '        stamp = path.stat().st_ctime',
  '        print(path.name, stamp)  # check before renaming',
].join('\n');

const tiles = (page) => page.eval(() => Object.fromEntries([...document.querySelectorAll('.tile')].map((t) => [t.querySelector('.tile-name').textContent, t.querySelector('.tile-value').textContent])));

// ------------------------------------------------------------------ scenarios

const SCENARIOS = [];
const scenario = (id, title, fn) => SCENARIOS.push({ id: String(id), title, fn });

scenario(1, 'magic link connects', async (ctx) => {
  const srv = await ctx.server();
  const page = await ctx.browser();
  await openApp(page, srv);
  const loc = await page.eval(() => ({ hash: location.hash, href: location.href }));
  eq(loc.hash, '', 'location.hash after connecting');
  assert(!loc.href.includes('key='), `the key is still in the address: ${loc.href}`);
  eq(await page.eval(() => JSON.parse(localStorage.getItem('ngla:server'))), { url: srv.url, key: srv.key }, 'localStorage ngla:server');
  const t = await tiles(page);
  eq(t.Memory, '32K tokens', 'Memory tile');
  eq(t.Pictures, 'On', 'Pictures tile');
  eq(t.Server, 'Kaggle 2× T4', 'Server tile');
  assert(await page.eval(() => window.__t.visible('#think')), 'the Think chip is not visible');
  eq(await page.eval(() => window.__t.text('#think-label')), 'Think: Balanced', 'Think chip label');
  eq(await page.eval(() => document.querySelectorAll('.prompts .prompt').length), 0, 'no starter prompts (removed on purpose)');
  eq(await page.eval(() => document.documentElement.dataset.theme), 'dark', 'default theme');
  await shot(page, 'desktop-dark-start.png');
  return `Ready; hash cleared; tiles ${JSON.stringify(t)}`;
});

scenario('1b', 'the file:// link dev_server prints works, chats survive a reload', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser();
  await page.goto(srv.link, { waitMs: 100 });
  await waitStatus(page, 'Ready');
  eq(await page.eval(() => location.protocol + ' ' + location.hash), 'file: ', 'protocol and hash');
  const r = await ask(page, 'hello from file');
  assert(r.text.includes('small script'), `reply: ${r.text.slice(0, 80)}`);
  await reload(page);
  await waitStatus(page, 'Ready');
  const titles = await page.eval(() => [...document.querySelectorAll('.chat-item .chat-title')].map((b) => b.textContent));
  eq(titles, ['hello from file'], 'chats after reload on file://');
  return 'connected over file://, chat kept after reload';
});

scenario(2, 'send a prompt: reasoning streams, then the answer; readings; saved across reload', async (ctx) => {
  const srv = await ctx.server(); // default 0.03 s between pieces
  const page = await ctx.browser();
  await openApp(page, srv);
  await page.eval(() => {
    window.__rec = [];
    const snap = () => {
      const r = window.__t.lastReply();
      if (!r) return;
      const s = { done: r.done, traceLive: r.traceLive, trace: r.traceText.length, text: r.text.length, status: document.getElementById('status-text').textContent };
      const last = window.__rec.at(-1);
      if (!last || JSON.stringify(last) !== JSON.stringify(s)) window.__rec.push(s);
    };
    new MutationObserver(snap).observe(document.getElementById('app'), { subtree: true, childList: true, characterData: true });
    return true;
  });
  const prompt = 'Write a Python script that renames files by date';
  const r = await ask(page, prompt);
  const rec = await page.eval(() => window.__rec);
  const iThink = rec.findIndex((s) => !s.done && s.traceLive && s.trace > 0 && s.text === 0);
  const iAnswer = rec.findIndex((s) => !s.done && s.text > 0);
  assert(iThink >= 0, 'never saw a live reasoning trace before the answer');
  assert(iAnswer > iThink, `the answer did not follow the trace (trace at ${iThink}, answer at ${iAnswer})`);
  const growing = new Set(rec.filter((s) => !s.done && s.text > 0).map((s) => s.text)).size;
  assert(growing >= 5, `the answer arrived in ${growing} steps, not streamed`);
  const statuses = [...new Set(rec.map((s) => s.status))];
  assert(statuses.includes('Thinking') && statuses.includes('Answering'), `status went ${statuses.join(' > ')}`);
  assert(/\d+\.\d tok\/s/.test(r.readings), `no tok/s in readings "${r.readings}"`);
  assert(/\d+ tokens/.test(r.readings), `no token count in readings "${r.readings}"`);
  assert(/first token \d/.test(r.readings), `no first-token time in readings "${r.readings}"`);
  assert(!r.traceLive && /^Reasoned/.test(r.traceTitle), `trace title after the reply: "${r.traceTitle}"`);
  eq(await page.eval(() => [...document.querySelectorAll('.chat-item .chat-title')].map((b) => b.textContent)), [prompt], 'sidebar chats');
  eq(await page.eval(() => window.__t.text('#chat-count')), '· 2 messages', 'message count');
  const [req] = srv.requests();
  eq(req.messages, [{ role: 'user', content: prompt }], 'messages sent');
  eq([req.model, req.think, req.stream, req.keep_alive, req.options?.num_ctx], ['local-model', 'medium', true, -1, 32768], 'model/think/stream/keep_alive/num_ctx');
  await reload(page);
  await waitStatus(page, 'Ready');
  eq(await page.eval(() => [...document.querySelectorAll('.chat-item .chat-title')].map((b) => b.textContent)), [prompt], 'sidebar chats after reload');
  await tap(page, '.chat-item .chat-title');
  const after = await page.eval(() => ({ n: document.querySelectorAll('#thread > .msg').length, reply: window.__t.lastReply() }));
  eq(after.n, 2, 'messages after reload');
  assert(after.reply.text.startsWith("Here's a small script") && after.reply.text.includes('Run it on a copy first.'), `reply after reload: ${after.reply.text.slice(0, 60)}`);
  const saved = await page.eval(() => window.__t.idb());
  eq(saved.length, 1, 'chats in IndexedDB');
  return `trace then answer (${rec.length} states, statuses ${statuses.join(' > ')}); readings "${r.readings}"`;
});

scenario(3, 'Markdown: code block with line numbers + Copy/Download, a table, a list', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.01']);
  const page = await ctx.browser();
  await openApp(page, srv);
  await ask(page, 'Write a Python script that renames files by date');
  const md = await page.eval(() => {
    const m = document.querySelector('#thread > .msg.assistant:last-child .prose');
    const cb = m.querySelector('.code-block');
    return {
      first: m.firstElementChild?.tagName + ' ' + m.firstElementChild?.textContent,
      lang: cb?.querySelector('.code-lang')?.textContent, count: cb?.querySelector('.code-count')?.textContent,
      gutter: cb?.querySelector('.code-gutter')?.textContent, code: cb?.querySelector('pre code')?.textContent,
      actions: [...(cb?.querySelectorAll('.code-action') || [])].map((b) => b.textContent.trim()),
      keywords: [...(cb?.querySelectorAll('.t-keyword') || [])].map((s) => s.textContent),
      comment: cb?.querySelector('.t-comment')?.textContent,
      head: [...m.querySelectorAll('.table-wrap thead th')].map((th) => th.textContent),
      rows: [...m.querySelectorAll('.table-wrap tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
      strong: m.querySelector('.table-wrap td strong')?.textContent,
      list: [...m.querySelectorAll(':scope > ul > li')].map((li) => li.textContent),
    };
  });
  eq(md.first, "P Here's a small script that does it.", 'first paragraph');
  eq([md.lang, md.count], ['python', '· 6 lines'], 'code head');
  eq(md.gutter, '1\n2\n3\n4\n5\n6', 'line numbers');
  eq(md.code, CODE, 'code text');
  eq(md.actions, ['Copy', 'Download'], 'code actions');
  for (const k of ['from', 'import', 'def', 'for', 'in']) assert(md.keywords.includes(k), `"${k}" isn't highlighted as a keyword (${md.keywords})`);
  eq(md.comment, '# check before renaming', 'highlighted comment');
  eq(md.head, ['Step', 'What happens'], 'table head');
  eq(md.rows, [['1', 'List the files'], ['2', 'Read each creation time']], 'table rows');
  eq(md.strong, 'creation time', 'bold inside a table cell');
  eq(md.list, ['It never overwrites a file.', 'Run it on a copy first.'], 'list items');
  await tap(page, '#thread > .msg.assistant:last-child .code-action:nth-child(1)');
  const copied = await until(page, () => { const b = document.querySelector('#thread > .msg.assistant:last-child .code-action'); return b.textContent.trim() === 'Copied' && window.__t.copied.at(-1); }, [], { what: 'Copy to say Copied' });
  eq(copied, CODE, 'copied text');
  await tap(page, '#thread > .msg.assistant:last-child .code-action:nth-child(2)');
  const dl = await until(page, async () => window.__t.downloads.length && { name: window.__t.downloads.at(-1).name, text: await window.__t.blobText() }, [], { what: 'the download' });
  eq(dl, { name: 'snippet.py', text: CODE }, 'downloaded snippet');
  await page.eval(() => { const s = document.getElementById('scroller'); s.scrollTop = 0; return true; });
  await shot(page, 'desktop-dark-conversation.png');
  return 'code block (6 numbered lines, Copy, Download), table (2 rows), list (2 items)';
});

scenario(4, 'Stop mid-reply keeps the partial text', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.05']);
  const page = await ctx.browser();
  await openApp(page, srv);
  await type(page, '#input', 'Write a Python script that renames files by date');
  await tap(page, '#send');
  await until(page, () => { const r = window.__t.lastReply(); return r && !r.done && r.text.length > 40; }, [], { what: 'the answer to start', timeout: 10000 });
  const mid = await page.eval(() => ({ label: document.getElementById('send').getAttribute('aria-label'), stop: document.getElementById('send').classList.contains('stop') }));
  eq(mid, { label: 'Stop', stop: true }, 'send button while answering');
  await shot(page, 'desktop-dark-streaming.png');
  await tap(page, '#send');
  const r = await until(page, () => { const r = window.__t.lastReply(); return r?.done && document.getElementById('send').getAttribute('aria-label') === 'Send' && r; }, [], { what: 'the reply to stop' });
  const full = "Here's a small script that does it.";
  assert(r.text.length > 0 && r.text.length < 300, `partial text length ${r.text.length}`);
  assert(r.text.startsWith(full.slice(0, 20)), `partial text: ${r.text.slice(0, 60)}`);
  assert(/stopped/.test(r.readings) && await page.eval(() => window.__t.visible('#thread > .msg.assistant:last-child .readings .stopped')), `readings "${r.readings}"`);
  assert(!r.error, `an error was shown: ${r.error}`);
  const composer = await page.eval(() => { const s = document.getElementById('send'); return { type: s.type, stop: s.classList.contains('stop'), label: s.getAttribute('aria-label') }; });
  eq(composer, { type: 'submit', stop: false, label: 'Send' }, 'composer after stopping');
  await waitStatus(page, 'Ready');
  const saved = (await page.eval(() => window.__t.idb()))[0].messages.at(-1);
  assert(saved.stopped === true && saved.content.startsWith("Here's a small script") && !saved.content.includes('Run it on a copy first.'), `saved reply: stopped=${saved.stopped}, "${saved.content.slice(0, 40)}"`);
  await reload(page);
  await waitStatus(page, 'Ready');
  await tap(page, '.chat-item .chat-title');
  const again = await page.eval(() => window.__t.lastReply());
  eq([again.text, /stopped/.test(again.readings)], [r.text, true], 'stopped reply after a reload');
  const next = await ask(page, 'and again');
  assert(next.text.includes('Run it on a copy first.'), 'the next reply after stopping did not complete');
  return `stopped at ${r.text.length} chars; readings "${r.readings}"; next reply complete`;
});

scenario(5, 'Answer again, and Edit a user message (truncates, re-sends)', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser();
  await openApp(page, srv);
  const a1 = await ask(page, 'first question');
  await tap(page, '#thread > .msg.assistant:last-child button[aria-label="Answer again"]');
  const a2 = await waitReply(page, a1.id);
  assert(a2.id !== a1.id && a2.text.includes('Run it on a copy first.'), 'Answer again did not produce a new full reply');
  eq(await page.eval(() => document.querySelectorAll('#thread > .msg').length), 2, 'messages after Answer again');
  let reqs = srv.requests();
  eq(reqs.length, 2, 'requests after Answer again');
  eq(reqs[1].messages, [{ role: 'user', content: 'first question' }], 'Answer again sends the history without the old reply');
  await ask(page, 'second question');
  eq(await page.eval(() => document.querySelectorAll('#thread > .msg').length), 4, 'messages before editing');
  const before = await page.eval(() => window.__t.lastReply().id);
  await tap(page, '#thread > .msg.user:first-child button[aria-label="Edit"]');
  const value = await until(page, () => document.querySelector('#thread > .msg.user:first-child .editor textarea')?.value, [], { what: 'the editor' });
  eq(value, 'first question', 'editor text');
  await type(page, '#thread > .msg.user:first-child .editor textarea', 'first question, edited');
  await tap(page, '#thread > .msg.user:first-child .editor-bar .btn-primary');
  const a3 = await waitReply(page, before);
  const thread = await page.eval(() => [...document.querySelectorAll('#thread > .msg')].map((m) => m.classList.contains('user') ? 'user:' + m.querySelector('.msg-text')?.textContent : 'assistant'));
  eq(thread, ['user:first question, edited', 'assistant'], 'thread after the edit');
  assert(a3.text.includes('Run it on a copy first.'), 'reply after edit incomplete');
  reqs = srv.requests();
  eq(reqs.at(-1).messages, [{ role: 'user', content: 'first question, edited' }], 'messages sent after the edit');
  eq(await page.eval(() => window.__t.text('#chat-count')), '· 2 messages', 'message count after the edit');
  const saved = (await page.eval(() => window.__t.idb()))[0];
  eq(saved.messages.map((m) => m.role + ':' + (m.role === 'user' ? m.content : 'reply')), ['user:first question, edited', 'assistant:reply'], 'saved chat after the edit');
  return 'Answer again re-sent [user]; edit truncated 4 -> 2 and re-sent the edited text';
});

scenario(6, 'Think Off sends think:false and shows no trace; Balanced still answers when levels are rejected', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser();
  await openApp(page, srv);
  await tap(page, '#think');
  const menu = await until(page, () => window.__t.visible('#effort-menu') && [...document.querySelectorAll('#effort-menu button')].map((b) => b.querySelector('b').textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')), [], { what: 'the Think menu' });
  eq(menu, ['Off', 'Quick', 'Balanced*', 'Deep'], 'Think menu');
  await shot(page, 'think-menu.png');
  await tap(page, '#effort-menu button:nth-child(1)');
  eq(await page.eval(() => [window.__t.text('#think-label'), document.getElementById('think').classList.contains('on'), window.__t.visible('#effort-menu')]), ['Think: off', false, false], 'Think chip after choosing Off');
  const r = await ask(page, 'no thinking please');
  assert(!r.trace, 'a reasoning trace was shown with Think off');
  eq(srv.requests().at(-1).think, false, 'think sent with Off');
  eq(await page.eval(() => JSON.parse(localStorage.getItem('ngla:prefs')).effort), 'off', 'saved effort');

  const strict = await ctx.server(['--delay', '0.005', '--think-levels-rejected']);
  const page2 = await ctx.browser();
  await openApp(page2, strict);
  const r2 = await ask(page2, 'think it through');
  assert(!r2.error, `error shown: ${r2.error}`);
  assert(r2.trace && r2.text.includes('Run it on a copy first.'), 'no full answer with a trace after the retry');
  eq(strict.requests().map((b) => b.think), ['medium', true], 'think values sent (retry after the 400)');
  return 'Off -> think:false, no trace; Balanced on a true/false-only model -> "medium" (400) then true';
});

scenario(7, 'no-vision server says "Attach file"; no-thinking server hides Think; pictures and files attach', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005', '--no-vision']);
  const page = await ctx.browser();
  await openApp(page, srv);
  eq(await page.eval(() => [window.__t.text('#attach-label'), window.__t.visible('#think')]), ['Attach file', true], 'attach label / Think chip (no vision)');
  eq((await tiles(page)).Pictures, 'Off', 'Pictures tile (no vision)');
  await page.eval(async () => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'pic.png', { type: 'image/png' }));
    dt.items.add(new File(['alpha beta gamma'], 'notes.txt', { type: 'text/plain' }));
    const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  const box = await until(page, () => document.querySelector('#composer-files .file-chip') && { chips: [...document.querySelectorAll('#composer-files .file-chip')].map((c) => c.textContent), thumbs: document.querySelectorAll('#composer-files .thumb').length, toast: document.querySelector('.toast')?.textContent || '' }, [], { what: 'the attachment' });
  eq(box, { chips: ['notes.txt'], thumbs: 0, toast: "This model can't see pictures" }, 'attachments on a no-vision server');
  const before = await page.eval(() => window.__t.lastReply()?.id || null);
  await tap(page, '#send');
  await waitReply(page, before);
  const req = srv.requests().at(-1);
  assert(req.messages[0].content.includes('File: notes.txt') && req.messages[0].content.includes('alpha beta gamma'), `file not sent: ${JSON.stringify(req.messages[0]).slice(0, 120)}`);
  assert(!('images' in req.messages[0]), 'images sent to a no-vision model');

  const plain = await ctx.server(['--delay', '0.005', '--no-thinking']);
  const page2 = await ctx.browser();
  await openApp(page2, plain);
  eq(await page2.eval(() => [window.__t.text('#attach-label'), window.__t.visible('#think'), document.getElementById('think').hidden]), ['Attach', false, true], 'attach label / Think chip (no thinking)');
  const r2 = await ask(page2, 'plain question');
  assert(!r2.trace, 'trace shown on a model without thinking');
  assert(!('think' in plain.requests().at(-1)), 'think sent to a model without thinking');

  const seeing = await ctx.server(['--delay', '0.005']);
  const page3 = await ctx.browser();
  await openApp(page3, seeing);
  await page3.eval(async () => {
    const c = document.createElement('canvas'); c.width = 2000; c.height = 1000;
    const g = c.getContext('2d'); g.fillStyle = '#3fd99a'; g.fillRect(0, 0, 2000, 1000);
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([png], 'wide.png', { type: 'image/png' }));
    const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  await until(page3, () => document.querySelector('#composer-files .thumb'), [], { what: 'the picture thumbnail' });
  await ask(page3, 'what colour is this');
  const sent = seeing.requests().at(-1).messages[0];
  assert(Array.isArray(sent.images) && sent.images.length === 1, 'picture not sent');
  const size = await page3.eval(async (b64) => { const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode(); return [img.naturalWidth, img.naturalHeight]; }, sent.images[0]);
  eq(size, [1280, 640], 'picture size sent');
  assert(sent.images[0].startsWith('/9j/'), 'picture is not a JPEG');
  assert(await page3.eval(() => Boolean(document.querySelector('#thread > .msg.user .thumb'))), 'no thumbnail in the sent message');
  return 'no-vision: "Attach file", picture refused, text file sent; no-thinking: chip hidden, no think; vision: 2000x1000 PNG sent as 1280x640 JPEG';
});

scenario(8, 'wrong key shows "Wrong key" and the connect screen; pasting the whole link connects', async (ctx) => {
  const srv = await ctx.server();
  const page = await ctx.browser();
  await openApp(page, srv, { key: 'not-the-key', ready: false });
  await waitStatus(page, 'Wrong key');
  const screen = await page.eval(() => ({ h1: window.__t.text('#thread h1'), eyebrow: window.__t.text('#thread .eyebrow'), form: Boolean(document.querySelector('#thread form.connect-card')) }));
  eq(screen, { h1: 'Open the newest link', eyebrow: "The key didn't work", form: true }, 'connect screen');
  await shot(page, 'connect-wrong-key.png');
  await type(page, '#thread form.connect-card input[aria-label="Key"]', 'leftover');
  await type(page, '#thread form.connect-card input[aria-label="Server address or link"]', linkFor(srv));
  eq(await page.eval(() => document.querySelector('#thread form.connect-card input[aria-label="Key"]').value), '', 'key field after pasting a whole link');
  await tap(page, '#thread form.connect-card button[type="submit"]');
  await waitStatus(page, 'Ready');
  eq(await page.eval(() => JSON.parse(localStorage.getItem('ngla:server')).key), srv.key, 'saved key');
  eq((await tiles(page)).Memory, '32K tokens', 'start screen after connecting');
  return 'Wrong key -> connect screen; pasted link -> Ready';
});

scenario('8b', 'a wrong key typed into the connect form shows an error message', async (ctx) => {
  const srv = await ctx.server();
  const page = await ctx.browser();
  await page.goto(PAGE, { waitMs: 100 });
  await waitStatus(page, 'Not connected');
  await type(page, '#thread form.connect-card input[aria-label="Server address or link"]', srv.url);
  await type(page, '#thread form.connect-card input[aria-label="Key"]', 'not-the-key');
  await tap(page, '#thread form.connect-card button[type="submit"]');
  await waitStatus(page, 'Wrong key');
  await sleep(200);
  const seen = await page.eval(() => [...document.querySelectorAll('.connect-error')].filter((n) => window.__t.visible(n) && n.textContent.trim()).map((n) => n.textContent));
  assert(seen.length, 'no error message is visible after submitting a wrong key (the form was rebuilt and the message went to the old one)');
  return `error shown: ${seen[0]}`;
});

scenario(9, 'Shut down from the menu: confirm, "Shut down", banner, server exits', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser();
  await openApp(page, srv);
  await ask(page, 'hello');
  await tap(page, '#more');
  await until(page, () => window.__t.visible('#more-menu') && !document.getElementById('menu-shutdown').disabled, [], { what: 'the menu' });
  await tap(page, '#menu-shutdown');
  const dlg = await until(page, () => document.getElementById('confirm').open && [window.__t.text('#confirm-title'), window.__t.text('#confirm-yes')], [], { what: 'the confirm dialog' });
  eq(dlg, ['Shut the server down?', 'Shut down'], 'confirm dialog');
  await shot(page, 'confirm-shutdown.png');
  await tap(page, '#confirm-yes');
  await waitStatus(page, 'Shut down');
  const banner = await until(page, () => window.__t.visible('#banner') && window.__t.text('#banner .banner-text'), [], { what: 'the banner' });
  assert(banner.startsWith('The server is shut down.'), `banner: ${banner}`);
  const code = await Promise.race([srv.exit, sleep(5000).then(() => 'still running')]);
  eq(code, 0, 'dev server exit');
  assert(srv.out.includes('Shut down from the chat.'), 'dev server did not log the shutdown');
  eq(await page.eval(() => document.getElementById('menu-shutdown').disabled), true, 'Shut down menu item after shutdown');
  await sleep(300);
  eq(await statusText(page), 'Shut down', 'status a moment later');
  await shot(page, 'shutdown-banner.png');
  return `status "Shut down", banner "${banner.slice(0, 40)}…", server exited 0`;
});

scenario(10, 'theme light/dark/system and text size apply to <html>', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser({ colorScheme: 'light' });
  await openApp(page, srv);
  await ask(page, 'Write a Python script that renames files by date');
  const look = () => page.eval(() => ({ theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor, pressed: [...document.querySelectorAll('[data-theme-choice]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.themeChoice) }));
  await tap(page, '[data-theme-choice="light"]');
  eq(await look(), { theme: 'light', bg: 'rgb(248, 248, 248)', pressed: ['light'] }, 'light');
  await page.eval(() => { document.getElementById('scroller').scrollTop = 0; return true; });
  await shot(page, 'desktop-light-conversation.png');
  await tap(page, '[data-theme-choice="dark"]');
  eq(await look(), { theme: 'dark', bg: 'rgb(17, 17, 17)', pressed: ['dark'] }, 'dark');
  await tap(page, '[data-theme-choice="system"]');
  eq(await look(), { theme: null, bg: 'rgb(248, 248, 248)', pressed: ['system'] }, 'system with a light OS');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  eq(await look(), { theme: null, bg: 'rgb(17, 17, 17)', pressed: ['system'] }, 'system with a dark OS');
  await tap(page, '#open-settings');
  await until(page, () => document.getElementById('settings').open, [], { what: 'Settings' });
  await shot(page, 'settings-dialog.png');
  const size = () => page.eval(() => [document.documentElement.dataset.size, getComputedStyle(document.getElementById('input')).fontSize, getComputedStyle(document.querySelector('.prose')).fontSize]);
  await tap(page, '#pref-size button[data-value="large"]');
  eq(await size(), ['large', '17px', '17px'], 'large text');
  await tap(page, '#pref-size button[data-value="small"]');
  eq(await size(), ['small', '14.5px', '14.5px'], 'small text');
  await tap(page, '#settings [data-close]');
  await reload(page);
  await waitStatus(page, 'Ready');
  eq(await page.eval(() => [document.documentElement.getAttribute('data-theme'), document.documentElement.dataset.size]), [null, 'small'], 'theme and size after reload');
  return 'light/dark/system follow the choice and the OS; small/large text sizes apply and persist';
});

scenario(11, 'phone width 390: drawer opens and closes, no sideways overflow, composer visible', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser({ width: 390, height: 844, mobile: true, touch: true });
  await openApp(page, srv);
  const env = await page.eval(() => ({ w: innerWidth, coarse: matchMedia('(pointer: coarse)').matches, scroll: document.documentElement.scrollWidth }));
  eq(env, { w: 390, coarse: true, scroll: 390 }, 'viewport');
  await shot(page, 'phone-start.png');
  const composer = () => page.eval(() => { const r = document.getElementById('composer').getBoundingClientRect(); const t = document.getElementById('input').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), input: Math.round(t.height) }; });
  let c = await composer();
  assert(c.top > 0 && c.bottom <= 844 && c.left >= 0 && c.right <= 390 && c.input > 20, `composer box ${JSON.stringify(c)}`);
  await ask(page, 'Write a Python script that renames files by date');
  const over = await page.eval(() => ({ html: document.documentElement.scrollWidth, topbar: document.querySelector('.topbar').scrollWidth - document.querySelector('.topbar').clientWidth }));
  eq(over, { html: 390, topbar: 0 }, 'page and top bar width with a conversation');
  const out = await page.eval(`(${escapes})('.topbar, #thread, .dock')`);
  eq(out, [], 'elements sticking out sideways');
  c = await composer();
  assert(c.top > 0 && c.bottom <= 844 && c.right <= 390, `composer box with a conversation ${JSON.stringify(c)}`);
  await shot(page, 'phone-conversation.png');
  const drawer = () => page.eval(() => { const r = document.getElementById('sidebar').getBoundingClientRect(); return { open: document.getElementById('app').classList.contains('drawer-open'), left: Math.round(r.left), right: Math.round(r.right), scrim: window.__t.visible('#scrim') }; });
  assert((await drawer()).right <= 0, 'the drawer is on screen before opening it');
  await tap(page, '#show-sidebar');
  await sleep(400);
  const d = await drawer();
  eq(d, { open: true, left: 0, right: 300, scrim: true }, 'drawer open');
  eq(await page.eval(() => [...document.querySelectorAll('.chat-item .chat-title')].map((b) => b.textContent)), ['Write a Python script that renames files by date'], 'chats in the drawer');
  await shot(page, 'phone-drawer.png');
  await tapAt(page, 360, 420); // the scrim beside the drawer
  await sleep(400);
  const closed = await drawer();
  assert(!closed.open && closed.right <= 0 && !closed.scrim, `drawer after tapping outside: ${JSON.stringify(closed)}`);
  await tap(page, '#show-sidebar');
  await sleep(400);
  await tap(page, '#new-chat');
  await sleep(400);
  assert(!(await drawer()).open, 'New chat left the drawer open');
  await tap(page, '#show-sidebar');
  await sleep(400);
  await tap(page, '.chat-item .chat-title');
  await sleep(400);
  assert(!(await drawer()).open, 'opening a chat left the drawer open');
  eq(await page.eval(() => document.querySelectorAll('#thread > .msg').length), 2, 'messages after opening the chat from the drawer');
  return `drawer 0..300 with scrim, closes on scrim / New chat / chat; no overflow; composer ${c.top}..${c.bottom}`;
});

scenario(12, 'export all -> delete all -> import restores the chats', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser();
  await openApp(page, srv);
  await ask(page, 'keep this chat');
  await ask(page, 'and this follow-up');
  const original = await page.eval(() => window.__t.idb());
  await tap(page, '#more');
  await tap(page, '#menu-export');
  const md = await until(page, async () => window.__t.downloads.length && { name: window.__t.downloads.at(-1).name, text: await window.__t.blobText() }, [], { what: 'the chat download' });
  assert(md.name === 'keep this chat.md' && md.text.startsWith('# keep this chat') && md.text.includes('**You:**\n\nkeep this chat'), `chat download ${md.name}: ${md.text.slice(0, 60)}`);
  await tap(page, '#open-settings');
  await until(page, () => document.getElementById('settings').open, [], { what: 'Settings' });
  await tap(page, '#export-all');
  const exp = await until(page, async () => window.__t.downloads.length > 1 && { name: window.__t.downloads.at(-1).name, type: window.__t.blobs.at(-1).type, text: await window.__t.blobText() }, [], { what: 'the export' });
  assert(/^chats-\d{4}-\d{2}-\d{2}\.json$/.test(exp.name) && exp.type === 'application/json', `export file ${exp.name} (${exp.type})`);
  const data = JSON.parse(exp.text);
  eq([data.app, data.version, data.chats.length, data.chats[0].messages.length], ['no-gpu-local-ai', 1, 1, 4], 'export contents');
  await tap(page, '#delete-all');
  await until(page, () => document.getElementById('confirm').open, [], { what: 'the confirm dialog' });
  await tap(page, '#confirm-yes');
  await until(page, () => window.__t.text('#chat-list') === "No chats yet. They're saved in this browser as you go.", [], { what: 'an empty chat list' });
  eq((await page.eval(() => window.__t.idb())).length, 0, 'chats in IndexedDB after Delete all');
  await page.eval((text) => {
    const dt = new DataTransfer(); dt.items.add(new File([text], 'chats.json', { type: 'application/json' }));
    const input = document.getElementById('import-input'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, exp.text);
  const toast = await until(page, () => document.querySelector('.toast')?.textContent, [], { what: 'the import toast' });
  eq(toast, 'Imported 1 chat', 'import toast');
  await tap(page, '#settings [data-close]');
  await reload(page);
  await waitStatus(page, 'Ready');
  const restored = await page.eval(() => window.__t.idb());
  eq(restored.map((c) => c.messages.map((m) => [m.role, m.content])), original.map((c) => c.messages.map((m) => [m.role, m.content])), 'messages after import + reload');
  await tap(page, '.chat-item .chat-title');
  eq(await page.eval(() => document.querySelectorAll('#thread > .msg').length), 4, 'messages shown after import');
  return `exported ${exp.name} (${exp.text.length} bytes), deleted, imported, reloaded: 1 chat, 4 messages`;
});

scenario(13, 'untrusted output renders as inert text, quickly', async (ctx) => {
  const reply = [
    'Plain start.',
    '',
    '<img src=x onerror="window.__pwned=1">',
    '',
    '<script>window.__pwned=2</script>',
    '',
    '[x](javascript:alert(1)) [y](JaVaScRiPt:alert(2)) [z](data:text/html;base64,PGI+aGk8L2I+) <a href="javascript:alert(3)">raw</a> <iframe src="javascript:alert(4)"></iframe>',
    '',
    '*'.repeat(20480),
    '',
    '*_'.repeat(10240),
    '',
    '_'.repeat(20480),
    '',
    'End.',
  ].join('\n');
  const file = path.join(TMP, 'untrusted.md');
  fs.writeFileSync(file, reply);
  const srv = await ctx.server(['--delay', '0.005', '--reply-file', file]);
  const page = await ctx.browser();
  await openApp(page, srv);
  await page.eval(() => { window.__t.longest = 0; return true; });
  const t0 = Date.now();
  const r = await ask(page, 'say something nasty', { timeout: 30000 });
  const streamMs = Date.now() - t0;
  const check = await page.eval(() => {
    const prose = document.querySelector('#thread > .msg.assistant:last-child .prose');
    const bad = [...prose.querySelectorAll('img, script, iframe, object, embed, style, link, svg, video, audio, form, input')].map((n) => n.tagName);
    const handlers = [...prose.querySelectorAll('*')].flatMap((n) => [...n.attributes].filter((a) => /^on/i.test(a.name)).map((a) => n.tagName + '@' + a.name));
    const hrefs = [...prose.querySelectorAll('[href], [src], a')].map((n) => n.getAttribute('href') || n.getAttribute('src') || n.tagName);
    const t = performance.now();
    document.getElementById('new-chat').click();
    document.querySelector('.chat-item .chat-title').click();
    void document.body.offsetHeight;
    const renderMs = performance.now() - t;
    return { bad, handlers, hrefs, pwned: window.__pwned ?? null, text: prose.textContent, renderMs: Math.round(renderMs), longest: Math.round(window.__t.longest), longtasks: PerformanceObserver.supportedEntryTypes.includes('longtask') };
  });
  assert(check.longtasks, 'this browser cannot report long tasks, so the streaming check would prove nothing');
  eq(check.bad, [], 'elements injected');
  eq(check.handlers, [], 'event-handler attributes');
  eq(check.hrefs, [], 'links in a reply whose only links are javascript: / data:');
  eq(check.pwned, null, 'window.__pwned');
  eq(page.dialogs, [], 'dialogs opened');
  for (const s of ['<img src=x onerror="window.__pwned=1">', '<script>window.__pwned=2</script>', 'x) y) z <a href="javascript:alert(3)">raw</a> <iframe', 'End.']) assert(check.text.includes(s), `"${s}" isn't shown as text`);
  assert(check.renderMs < 1000, `re-rendering the reply took ${check.renderMs} ms`);
  assert(check.longest < 1000, `a ${check.longest} ms task blocked the page while it streamed`);
  await page.eval(() => { document.getElementById('scroller').scrollTop = 0; return true; });
  await shot(page, 'untrusted-output.png');
  return `inert; re-render ${check.renderMs} ms, longest task ${check.longest} ms, whole reply ${streamMs} ms`;
});

scenario('13b', 'a long run of [ or ` (a model stuck repeating) still renders under 1 s', async (ctx) => {
  const file = path.join(TMP, 'runs.md');
  fs.writeFileSync(file, 'Here it goes:\n\nx' + '['.repeat(40000) + '\n\ny' + '`'.repeat(40000) + '\n');
  const srv = await ctx.server(['--delay', '0.005', '--reply-file', file]);
  const page = await ctx.browser();
  await openApp(page, srv);
  await ask(page, 'repeat yourself', { timeout: 60000 });
  const ms = await page.eval(() => {
    const t = performance.now();
    document.getElementById('new-chat').click();
    document.querySelector('.chat-item .chat-title').click();
    void document.body.offsetHeight;
    return Math.round(performance.now() - t);
  });
  assert(ms < 1000, `rendering two 40,000-character lines took ${ms} ms (the inline Markdown regex backtracks quadratically on "[" and backtick runs)`);
  return `${ms} ms`;
});

scenario(14, 'deleting a chat while it is answering keeps it deleted after a reload', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.05']);
  const page = await ctx.browser();
  await openApp(page, srv);
  await type(page, '#input', 'delete me while you answer');
  await tap(page, '#send');
  await until(page, () => { const r = window.__t.lastReply(); return r && !r.done && r.text.length > 10; }, [], { what: 'the answer to start' });
  await tap(page, '#more');
  await tap(page, '#menu-delete');
  await until(page, () => document.getElementById('confirm').open, [], { what: 'the confirm dialog' });
  await tap(page, '#confirm-yes');
  await until(page, () => !document.querySelector('.chat-item'), [], { what: 'the chat to leave the list' });
  await sleep(500);
  const stored = (await page.eval(() => window.__t.idb())).map((c) => c.title);
  await reload(page);
  await waitStatus(page, 'Ready');
  const listed = await page.eval(() => [...document.querySelectorAll('.chat-item .chat-title')].map((b) => b.textContent));
  assert(!listed.length && !stored.length, `the deleted chat came back after a reload: IndexedDB ${JSON.stringify(stored)}, sidebar ${JSON.stringify(listed)}`);
  return 'stayed deleted';
});

scenario('14b', '"Delete all" while a reply is streaming keeps everything deleted after a reload', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.05']);
  const page = await ctx.browser();
  await openApp(page, srv);
  await type(page, '#input', 'private question');
  await tap(page, '#send');
  await until(page, () => { const r = window.__t.lastReply(); return r && !r.done && r.text.length > 10; }, [], { what: 'the answer to start' });
  await tap(page, '#open-settings');
  await tap(page, '#delete-all');
  await until(page, () => document.getElementById('confirm').open, [], { what: 'the confirm dialog' });
  await tap(page, '#confirm-yes');
  await sleep(600);
  await reload(page);
  await waitStatus(page, 'Ready');
  const listed = await page.eval(() => [...document.querySelectorAll('.chat-item .chat-title')].map((b) => b.textContent));
  eq(listed, [], 'chats listed after Delete all + reload');
  return 'stayed deleted';
});

scenario(15, 'an edit in progress survives the 30-second status poll', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser({ poll: true }); // the 30 s poll fires after 1.5 s
  await openApp(page, srv);
  await ask(page, 'original wording');
  await tap(page, '#thread > .msg.user:first-child button[aria-label="Edit"]');
  await until(page, () => document.querySelector('#thread .editor textarea'), [], { what: 'the editor' });
  await type(page, '#thread .editor textarea', 'a much better wording I spent a while on');
  const polls = () => page.eval(() => performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/info')).length);
  const n0 = await polls();
  await until(page, (n) => performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/info')).length > n, [n0], { timeout: 6000, what: 'the next status poll' });
  await sleep(300);
  const value = await page.eval(() => document.querySelector('#thread .editor textarea')?.value ?? '(editor gone)');
  eq(value, 'a much better wording I spent a while on', 'editor text after a status poll');
  return 'kept';
});

scenario(16, '"Answer again" while the server is down keeps the existing answer', async (ctx) => {
  const srv = await ctx.server(['--delay', '0.005']);
  const page = await ctx.browser();
  await openApp(page, srv);
  const a = await ask(page, 'an answer worth keeping');
  await tap(page, '#more');
  await tap(page, '#menu-shutdown');
  await until(page, () => document.getElementById('confirm').open, [], { what: 'the confirm dialog' });
  await tap(page, '#confirm-yes');
  await waitStatus(page, 'Shut down');
  await tap(page, '#thread > .msg.assistant:last-child button[aria-label="Answer again"]');
  await until(page, () => window.__t.visible('#banner'), [], { what: 'the banner' });
  await tap(page, '#new-chat');
  await tap(page, '.chat-item .chat-title');
  const shown = await page.eval(() => [...document.querySelectorAll('#thread > .msg')].map((m) => m.classList.contains('user') ? 'user' : 'assistant'));
  const next = await ctx.server(['--delay', '0.005']);
  await page.goto(linkFor(next), { waitMs: 100 }); // a new notebook link, opened in the same tab
  await waitStatus(page, 'Ready');
  await tap(page, '.chat-item .chat-title');
  await ask(page, 'a follow-up');
  const saved = (await page.eval(() => window.__t.idb()))[0].messages.map((m) => m.role);
  assert(shown.length === 2 && saved.length === 4, `after "Answer again" with the server down the thread showed ${JSON.stringify(shown)}; after reconnecting and a follow-up the saved chat is ${JSON.stringify(saved)} (the answer "${a.text.slice(0, 30)}…" is gone)`);
  return 'answer kept';
});

// ------------------------------------------------------------------ runner

async function main() {
  if (argv.includes('--list')) { for (const s of SCENARIOS) console.log(`${s.id.padEnd(4)} ${s.title}`); return 0; }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const web = await serve(path.join(REPO, 'web'));
  PAGE = web.base + 'index.html';
  let failed = 0, ran = 0;
  try {
    for (const s of SCENARIOS) {
      if (ONLY && !ONLY.has(s.id)) continue;
      ran++;
      const ctx = { pages: [], servers: [] };
      ctx.server = async (flags) => { const srv = await startServer(flags); ctx.servers.push(srv); return srv; };
      ctx.browser = (o) => browser(ctx, o);
      const t0 = Date.now();
      let ok = true, reason = '';
      try { reason = (await s.fn(ctx)) || 'ok'; } catch (e) { ok = false; reason = e.message; }
      const thrown = ctx.pages.flatMap((p) => p.issues.filter((i) => i.type === 'exception' || (i.type === 'console' && !/Failed to load resource|fonts\.g/i.test(i.text))));
      if (ok && thrown.length) { ok = false; reason = `page errors: ${thrown.slice(0, 3).map((i) => i.text.split('\n')[0]).join(' | ')}`; }
      for (const p of ctx.pages) await p.close().catch(() => {});
      for (const srv of ctx.servers) await srv.stop().catch(() => {});
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${s.id.padEnd(4)}${s.title}  (${((Date.now() - t0) / 1000).toFixed(1)} s)\n     ${reason}`);
    }
  } finally {
    await web.close();
    for (const srv of SERVERS) await srv.stop().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${ran - failed}/${ran} passed${SHOTS ? `; screenshots in ${SHOTS}` : ''}`);
  return failed ? 1 : 0;
}

process.exitCode = await main();
