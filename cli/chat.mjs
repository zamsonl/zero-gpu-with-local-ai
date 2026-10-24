#!/usr/bin/env node
// Chat in a terminal with the model your no-gpu-local-ai notebook is running on Kaggle or Colab.
//
//   node chat.mjs "<the link the notebook printed>"
//   node chat.mjs --server https://xxxx.trycloudflare.com --key YOUR-KEY
//   node chat.mjs                      (the last server again)
//
// Node 18 or newer, nothing to install. Settings and chats are kept in ~/.no-gpu-local-ai (or the
// folder in $NO_GPU_HOME), the chats in the same shape the web app keeps them, so an export from
// either one imports into the other.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const APP = "no-gpu-local-ai";
const IMAGE_TOKENS = 800; // what a picture roughly costs the model's memory
const CHARS_PER_TOKEN = 3.2;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_FILE = 400_000;
const INFO_TIMEOUT_MS = 15_000;
const PASTE_GAP_MS = 30; // lines closer together than this were pasted, not typed

export const EFFORTS = {
  off: { label: "off", note: "answers straight away", value: false },
  quick: { label: "quick", note: "thinks briefly first", value: "low" },
  balanced: { label: "balanced", note: "thinks it through", value: "medium" },
  deep: { label: "deep", note: "takes its time, best for hard problems", value: true },
};

const DEFAULT_CONFIG = { server: "", key: "", effort: "balanced", system: "", temperature: "" };

class UsageError extends Error {}

// ------------------------------------------------------------------ output

const out = (text) => process.stdout.write(text);
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || "") || Boolean(process.env.WT_SESSION);
const paint = (code) => (text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const c = {
  dim: paint("2"),
  bold: paint("1"),
  violet: paint(TRUECOLOR ? "38;2;147;132;255" : "38;5;141"),
  mint: paint(TRUECOLOR ? "38;2;63;217;154" : "38;5;79"),
  warn: paint(TRUECOLOR ? "38;2;240;177;76" : "38;5;215"),
  red: paint(TRUECOLOR ? "38;2;255;122;122" : "38;5;210"),
};
const say = (text) => out(text + "\n");
const note = (text) => out(c.dim(text) + "\n");
const warn = (text) => out(c.warn(text) + "\n");

// ------------------------------------------------------------------ small helpers

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fmtDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}
export const fmtTokens = (n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));
export const fmtSecs = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : fmtDuration(ms / 1000));
const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function titleFrom(text) {
  const line = String(text || "").trim().split("\n").find((l) => l.trim()) || "Pictures";
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "…" : line.trim();
}

const unquote = (text) => String(text || "").trim().replace(/^(["'])(.*)\1$/s, "$2");

function expandPath(text) {
  const p = unquote(text);
  if (p === "~") return os.homedir();
  if (/^~[\\/]/.test(p)) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

// ------------------------------------------------------------------ links and the server

/** The notebook's server address, reduced to its origin; adds https:// when it's left out. */
export function normaliseUrl(text) {
  let value = String(text || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

/** The notebook's link: ...#server=<url>&key=<key>. Returns { url, key } or null. */
export function parseLink(text) {
  const s = unquote(text);
  const hashAt = s.indexOf("#");
  const parts = [];
  if (hashAt >= 0) parts.push(s.slice(hashAt + 1));
  const queryAt = s.indexOf("?");
  if (queryAt >= 0) parts.push(s.slice(queryAt + 1, hashAt > queryAt ? hashAt : undefined));
  if (/^(server|key)=/.test(s)) parts.push(s);
  for (const part of parts) {
    const params = new URLSearchParams(part);
    const url = normaliseUrl(params.get("server"));
    const key = (params.get("key") || "").trim();
    if (url && key) return { url, key };
  }
  return null;
}

export function parseArgs(argv) {
  const args = { help: false, server: "", key: "", link: "", exportFile: "", importFile: "" };
  for (let i = 0; i < argv.length; i++) {
    let name = argv[i];
    let value;
    const eq = name.startsWith("--") ? name.indexOf("=") : -1;
    if (eq > 0) [name, value] = [name.slice(0, eq), name.slice(eq + 1)];
    const take = () => {
      if (value !== undefined) return value;
      if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value after it.`);
      return argv[++i];
    };
    if (name === "-h" || name === "--help") args.help = true;
    else if (name === "--server") args.server = take();
    else if (name === "--key") args.key = take();
    else if (name === "--export") args.exportFile = take();
    else if (name === "--import") args.importFile = take();
    else if (name.startsWith("-") && name !== "-") throw new UsageError(`There's no ${name} option.`);
    else if (args.link) throw new UsageError("Give one link (in quotes), or --server and --key.");
    else args.link = name;
  }
  return args;
}

/** Where to connect: the link, else --server/--key, else the saved server. null when there's none. */
export function resolveTarget(args, cfg) {
  if (args.link) {
    const link = parseLink(args.link);
    if (link) return link;
    const url = normaliseUrl(args.link);
    const key = args.key || (url && url === cfg.server ? cfg.key : "");
    if (url && key) return { url, key };
    throw new UsageError(
      "That link has no key in it. Copy the whole link the notebook printed (it ends in &key=...) and put it in quotes, " +
        "because the & and # in it mean something to your shell.",
    );
  }
  if (args.server || args.key) {
    const link = args.server ? parseLink(args.server) : null;
    if (link) return link;
    const url = args.server ? normaliseUrl(args.server) : cfg.server;
    if (args.server && !url) throw new UsageError("That server address doesn't look right. It looks like https://something.trycloudflare.com");
    if (!url) throw new UsageError("Add --server with the address the notebook printed.");
    const key = args.key || (url === cfg.server ? cfg.key : "");
    if (!key) throw new UsageError("Add --key with the key the notebook printed.");
    return { url, key };
  }
  return cfg.server && cfg.key ? { url: cfg.server, key: cfg.key } : null;
}

const auth = (key) => ({ authorization: `Bearer ${key}` });

/** GET /info. { ok: true, info } or { ok: false, why: "key" | "offline" | "loading" | "other", detail }. */
async function getInfo(conn) {
  let res;
  try {
    res = await fetch(conn.url + "/info", { headers: auth(conn.key), signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
  } catch {
    return { ok: false, why: "offline" };
  }
  if (res.status === 401) return { ok: false, why: "key" };
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const tunnelGone = [502, 503, 504, 520, 521, 522, 523, 524, 530].includes(res.status) && !body;
    return { ok: false, why: tunnelGone ? "offline" : "other", detail: `it answered ${res.status}` };
  }
  if (body?.app === APP && body.model) return { ok: true, info: body };
  if (body && typeof body === "object" && "uptime_s" in body && !body.app) return { ok: false, why: "loading" };
  return { ok: false, why: "other", detail: "it answered something else" };
}

function explainFailure(result, conn) {
  if (result.why === "key")
    return [
      "The server didn't accept the key.",
      "Copy the newest link from the notebook's output and run:",
      '  node chat.mjs "<the link>"',
      "or use --server and --key with the address and key printed under it.",
    ].join("\n");
  if (result.why === "offline")
    return [
      `Couldn't reach ${conn.url}.`,
      "The notebook's session may have ended. Run the notebook again and use the new link it prints.",
    ].join("\n");
  if (result.why === "loading") return "The server is up, but the model is still loading. Try again in a minute.";
  return `${conn.url} answered, but it isn't a ${APP} server (${result.detail}). Check the address, or use the newest link from the notebook.`;
}

function errorText(raw, status) {
  let message = raw;
  try {
    message = JSON.parse(raw).error || raw;
  } catch {}
  message = String(message || "").trim().slice(0, 300);
  if (status === 502 || status === 530 || /cloudflare/i.test(message)) return OFFLINE_REPLY;
  return message || `The server answered ${status}.`;
}

const OFFLINE_REPLY = "Couldn't reach the server. Its session may have ended: run the notebook again, then /connect with the new link.";

export function gpuLabel(info) {
  if (!info?.gpus?.length) return "";
  const names = info.gpus.map((g) => String(g).replace(/^(NVIDIA|Tesla)\s+/i, "").replace(/^Tesla\s+/i, ""));
  const same = names.every((n) => n === names[0]);
  return same ? `${names.length > 1 ? names.length + "× " : ""}${names[0]}` : names.join(" + ");
}

const platformName = (p) => ({ kaggle: "Kaggle", colab: "Colab" })[p] || (p ? String(p)[0].toUpperCase() + String(p).slice(1) : "Server");

// ------------------------------------------------------------------ the conversation

/** Some models write their reasoning inside <think> tags instead of a separate field. */
export function splitThinking(message) {
  const content = message.content || "";
  if (message.thinking || !content.trimStart().startsWith("<think>")) return { thinking: message.thinking || "", content };
  const body = content.trimStart().slice(7);
  const end = body.indexOf("</think>");
  return end < 0 ? { thinking: body, content: "" } : { thinking: body.slice(0, end), content: body.slice(end + 8).trimStart() };
}

/** splitThinking for a reply still arriving: holds back what might be the start of a tag. */
export function liveSplit(message, final = false) {
  const content = message.content || "";
  if (message.thinking) return { thinking: message.thinking, content };
  const trimmed = content.trimStart();
  if (!final && trimmed.length < 7 && "<think>".startsWith(trimmed)) return { thinking: "", content: "" };
  if (!trimmed.startsWith("<think>")) return { thinking: "", content };
  const body = trimmed.slice(7);
  const end = body.indexOf("</think>");
  if (end >= 0) return { thinking: body.slice(0, end), content: body.slice(end + 8).trimStart() };
  return { thinking: final ? body : body.slice(0, Math.max(0, body.length - 8)), content: "" };
}

export function messageText(message) {
  const files = (message.files || []).map((f) => `File: ${f.name}\n\`\`\`\n${f.text}\n\`\`\``).join("\n\n");
  return files ? `${files}\n\n${message.content}` : message.content;
}

/** The newest messages that fit the model's memory, leaving room for the reply (as the web app does). */
export function buildContext(history, { numCtx, system = "", vision = false } = {}) {
  const ctx = numCtx || 8192;
  const reserve = Math.min(8192, Math.floor(ctx / 4));
  let budget = (ctx - reserve) * CHARS_PER_TOKEN;
  const sys = String(system || "").trim();
  if (sys) budget -= sys.length;
  const kept = [];
  const usable = history.filter((m) => m.role === "user" || splitThinking(m).content.trim());
  for (let k = usable.length - 1; k >= 0; k--) {
    const m = usable[k];
    const content = m.role === "assistant" ? splitThinking(m).content : messageText(m);
    const images = vision ? (m.images || []).map((img) => img.data) : [];
    const cost = content.length + images.length * IMAGE_TOKENS * CHARS_PER_TOKEN;
    if (cost > budget && kept.length) break;
    budget -= cost;
    kept.unshift(images.length ? { role: m.role, content, images } : { role: m.role, content });
  }
  const dropped = usable.length - kept.length;
  if (sys) kept.unshift({ role: "system", content: sys });
  return { messages: kept, dropped };
}

/** What goes in the request's think field for an effort, or undefined to leave it out. */
export function thinkValue(effort, { thinking = true, levelsRejected = false } = {}) {
  if (!thinking) return undefined;
  const value = (EFFORTS[effort] || EFFORTS.balanced).value;
  return levelsRejected && typeof value === "string" ? true : value;
}

function printReadings(message) {
  const line = readings(message);
  const speed = line.match(/^[\d.]+ tok\/s/)?.[0] || "";
  if (line) say(c.mint(speed) + c.dim(line.slice(speed.length)));
}

export function readings(message) {
  const s = message.stats || {};
  const parts = [];
  if (s.tps) parts.push(`${s.tps.toFixed(1)} tok/s`);
  if (s.tokens) parts.push(`${s.tokens} tokens`);
  if (s.first_token_ms != null) parts.push(`first token ${fmtSecs(s.first_token_ms)}`);
  if (message.stopped) parts.push("stopped");
  if (s.dropped) parts.push(`${s.dropped} older ${s.dropped === 1 ? "message" : "messages"} left out to fit`);
  return parts.join("  ");
}

// ------------------------------------------------------------------ files: config, chats, attachments

export function homeDir() {
  return process.env.NO_GPU_HOME ? path.resolve(process.env.NO_GPU_HOME) : path.join(os.homedir(), `.${APP}`);
}

/** Writes a file only its owner can read (where the OS has such modes), replacing it in one step. */
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.rmSync(temp, { force: true });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function loadConfig(home) {
  const file = path.join(home, "config.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const cfg = { ...DEFAULT_CONFIG };
    for (const name of Object.keys(DEFAULT_CONFIG)) if (saved && saved[name] !== undefined && saved[name] !== null) cfg[name] = saved[name];
    if (!EFFORTS[cfg.effort]) cfg.effort = DEFAULT_CONFIG.effort;
    cfg.server = normaliseUrl(cfg.server);
    cfg.key = typeof cfg.key === "string" ? cfg.key : "";
    cfg.system = typeof cfg.system === "string" ? cfg.system : "";
    return cfg;
  } catch (err) {
    if (err.code !== "ENOENT") warn(`Couldn't read ${file}, so the settings start fresh.`);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(home, cfg) {
  const { server, key, effort, system, temperature } = cfg;
  writePrivate(path.join(home, "config.json"), JSON.stringify({ server, key, effort, system, temperature }, null, 2) + "\n");
}

const chatsDir = (home) => path.join(home, "chats");

/** The chat's file name: its id when that's safe as a name, else a hash of it. */
export function chatFileName(id) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? `${id}.json` : `x-${crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 32)}.json`;
}

const isChat = (chat) => Boolean(chat && typeof chat === "object" && typeof chat.id === "string" && chat.id && Array.isArray(chat.messages));

/** What the web app's import keeps: user and assistant messages with text content. */
function cleanChat(chat) {
  const now = Date.now();
  return {
    ...chat,
    title: typeof chat.title === "string" ? chat.title : "",
    created: Number.isFinite(chat.created) ? chat.created : now,
    updated: Number.isFinite(chat.updated) ? chat.updated : now,
    messages: chat.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"),
  };
}

function loadChats(home) {
  let names = [];
  try {
    names = fs.readdirSync(chatsDir(home)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const chats = [];
  for (const name of names) {
    try {
      const chat = JSON.parse(fs.readFileSync(path.join(chatsDir(home), name), "utf8"));
      if (isChat(chat)) chats.push(cleanChat(chat));
    } catch {}
  }
  return chats.sort((a, b) => b.updated - a.updated);
}

const writeChat = (home, chat) => writePrivate(path.join(chatsDir(home), chatFileName(chat.id)), JSON.stringify(chat, null, 1));
const deleteChatFile = (home, chat) => fs.rmSync(path.join(chatsDir(home), chatFileName(chat.id)), { force: true });

function exportChats(home, file) {
  const chats = loadChats(home);
  const text = JSON.stringify({ app: APP, version: 1, chats }, null, 1);
  if (file === "-") {
    out(text + "\n");
    return 0;
  }
  try {
    fs.writeFileSync(path.resolve(file), text, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`Couldn't write ${file}: ${err.message}\n`);
    return 1;
  }
  say(`Saved ${plural(chats.length, "chat")} to ${path.resolve(file)}.`);
  note("The web app can import it too: Settings, then Import under Your chats.");
  return 0;
}

function importChats(home, file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (err) {
    process.stderr.write(err.code === "ENOENT" ? `Couldn't find ${file}.\n` : `${file} isn't a chat export.\n`);
    return 1;
  }
  if (!data || !Array.isArray(data.chats)) {
    process.stderr.write(`${file} isn't a chat export (there are no chats in it).\n`);
    return 1;
  }
  const incoming = data.chats.filter(isChat).map(cleanChat);
  let replaced = 0;
  for (const chat of incoming) {
    if (fs.existsSync(path.join(chatsDir(home), chatFileName(chat.id)))) replaced++;
    writeChat(home, chat);
  }
  say(`Imported ${plural(incoming.length, "chat")}${replaced ? ` (${replaced} replaced the copy already here)` : ""}.`);
  return 0;
}

/** PNG, JPEG, GIF or WebP from the first bytes, or null. */
export function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export const looksBinary = (buf) => buf.subarray(0, 4096).includes(0);

// ------------------------------------------------------------------ reading what's typed

const MAIN_PROMPT = "> ";
const MORE_PROMPT = "… ";
const COMMANDS = ["/help", "/new", "/list", "/open", "/delete", "/title", "/retry", "/think", "/system", "/image", "/file", "/info", "/connect", "/shutdown", "/exit"];

function completer(line) {
  const think = line.match(/^\/think\s+(\S*)$/);
  if (think) return [["off", "quick", "balanced", "deep", "show", "hide"].filter((o) => o.startsWith(think[1])).map((o) => `/think ${o}`), line];
  const file = line.match(/^(\/(?:file|image)\s+)(.*)$/);
  if (file) {
    const typed = file[2];
    const cut = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\")) + 1;
    const dir = typed.slice(0, cut);
    try {
      const hits = fs
        .readdirSync(expandPath(dir || "."), { withFileTypes: true })
        .filter((e) => e.name.startsWith(typed.slice(cut)))
        .map((e) => file[1] + dir + e.name + (e.isDirectory() ? "/" : ""));
      return [hits, line];
    } catch {
      return [[], line];
    }
  }
  if (line.startsWith("/") && !line.includes(" ")) {
    const hits = COMMANDS.filter((name) => name.startsWith(line));
    return [hits.length ? hits : COMMANDS, line];
  }
  return [[], line];
}

/** readline's output while a reply streams: what's typed meanwhile is kept, but not drawn over the reply. */
function quietableOutput() {
  return {
    muted: true,
    isTTY: true,
    get columns() {
      return process.stdout.columns;
    },
    get rows() {
      return process.stdout.rows;
    },
    write(chunk, encoding, callback) {
      if (!this.muted) process.stdout.write(chunk);
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done();
      return true;
    },
    on(event, fn) {
      process.stdout.on(event, fn);
      return this;
    },
    once(event, fn) {
      process.stdout.once(event, fn);
      return this;
    },
    off(event, fn) {
      process.stdout.off(event, fn);
      return this;
    },
    removeListener(event, fn) {
      process.stdout.removeListener(event, fn);
      return this;
    },
  };
}

/**
 * Lines in the order they arrive, from a person at a terminal or from a pipe. In a terminal it
 * draws the prompt; from a pipe it echoes each line, so the output reads like a transcript.
 */
class Input {
  constructor() {
    // NO_GPU_TERMINAL=1 treats piped input as a terminal, for the tests.
    this.terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY) || process.env.NO_GPU_TERMINAL === "1";
    this.echo = !this.terminal && !process.stdin.isTTY;
    this.queue = [];
    this.closed = false;
    this.wakeUp = null;
    this.atPrompt = false;
    this.onInterrupt = () => {};
    this.output = this.terminal ? quietableOutput() : null;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: this.output || undefined,
      terminal: this.terminal,
      historySize: this.terminal ? 500 : 0,
      completer: this.terminal ? completer : undefined,
    });
    this.rl.on("line", (line) => this.push({ line, at: Date.now(), ahead: !this.atPrompt }));
    this.rl.on("close", () => {
      this.closed = true;
      this.wake();
    });
    if (this.terminal) this.rl.on("SIGINT", () => this.onInterrupt());
    process.on("SIGINT", () => this.onInterrupt());
  }

  push(item) {
    this.queue.push(item);
    this.wake();
  }

  wake() {
    const resolve = this.wakeUp;
    this.wakeUp = null;
    if (resolve) resolve();
  }

  /** The next line ({ line } or { cancel }), or null once the input has ended. */
  async take(prompt) {
    if (!this.queue.length && !this.closed) {
      this.atPrompt = true;
      if (this.terminal) {
        this.output.muted = false;
        this.rl.setPrompt(c.violet(prompt));
        this.rl.prompt(true);
      }
      while (!this.queue.length && !this.closed) await new Promise((resolve) => (this.wakeUp = resolve));
    }
    this.atPrompt = false;
    if (this.output) this.output.muted = true;
    const item = this.queue.shift() || null;
    if (item?.line !== undefined && (this.echo || (this.terminal && item.ahead))) out(c.violet(prompt) + redact(item.line) + "\n");
    return item;
  }

  /** True when the line after this one came with it, the way a paste arrives. */
  async pastedWith(item) {
    if (!this.terminal) return false;
    if (!this.queue.length && !this.closed) await sleep(PASTE_GAP_MS);
    const next = this.queue[0];
    return Boolean(next && next.line !== undefined && next.at - item.at <= PASTE_GAP_MS);
  }

  /** Text typed on the prompt line but not sent yet. */
  hasDraft() {
    return this.terminal && this.rl.line.length > 0;
  }

  clearDraft() {
    if (!this.hasDraft()) return false;
    this.rl.write(null, { ctrl: true, name: "e" });
    this.rl.write(null, { ctrl: true, name: "u" });
    return true;
  }

  close() {
    try {
      this.rl.close();
    } catch {}
  }
}

/** Echoed lines never show a key: /connect shows only the address. */
function redact(line) {
  if (!/^\s*\/connect\b/i.test(line)) return line;
  const target = parseConnect(line.replace(/^\s*\/connect\b/i, ""));
  return target.url ? `/connect ${target.url} (key hidden)` : "/connect (hidden)";
}

function parseConnect(rest) {
  const words = rest.trim().split(/\s+/).filter(Boolean).map(unquote);
  if (!words.length) return {};
  const link = parseLink(words[0]);
  if (link) return link;
  const url = normaliseUrl(words[0]);
  return url ? { url, key: words[1] || "" } : {};
}

// ------------------------------------------------------------------ printing a reply as it streams

class ReplyPrinter {
  constructor({ showThinking }) {
    this.showThinking = showThinking;
    this.tty = Boolean(process.stdout.isTTY);
    this.phase = "waiting"; // waiting | thinking | answer
    this.shown = { thinking: 0, content: 0 };
    this.placeholder = "";
    this.thinkingFrom = 0;
    this.resetBlock();
  }

  resetBlock() {
    this.started = false; // anything visible written in this block yet
    this.newlines = 0; // held back until more text comes, so trailing blank lines vanish
    this.lineStart = true;
  }

  start() {
    if (this.tty) this.setPlaceholder("Reading the conversation...");
  }

  setPlaceholder(text) {
    this.clearPlaceholder();
    out(c.dim(text));
    this.placeholder = text;
  }

  clearPlaceholder() {
    if (this.placeholder) out("\r\x1b[K");
    this.placeholder = "";
  }

  update(message, final = false) {
    const view = liveSplit(message, final);
    if (view.thinking.length > this.shown.thinking) {
      this.thinking(view.thinking.slice(this.shown.thinking));
      this.shown.thinking = view.thinking.length;
    }
    if (view.content.length > this.shown.content) {
      this.content(view.content.slice(this.shown.content));
      this.shown.content = view.content.length;
    }
  }

  thinking(text) {
    if (this.phase === "waiting") {
      this.clearPlaceholder();
      this.phase = "thinking";
      this.thinkingFrom = performance.now();
      if (!this.showThinking && this.tty) this.setPlaceholder("Thinking...");
    }
    if (this.phase === "thinking" && this.showThinking) this.write(text, c.dim, this.tty ? "│ " : "| ");
  }

  endThinking() {
    const took = fmtSecs(performance.now() - this.thinkingFrom);
    if (this.showThinking) {
      if (this.started) out("\n\n");
    } else {
      this.clearPlaceholder();
      out(c.dim(`Thought for ${took}`) + "\n\n");
    }
  }

  content(text) {
    if (this.phase === "thinking") this.endThinking();
    if (this.phase !== "answer") {
      this.clearPlaceholder();
      this.phase = "answer";
      this.resetBlock();
    }
    this.write(text, (s) => s, "");
  }

  write(text, style, bar) {
    const pieces = text.split("\n");
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0 && this.started) this.newlines++;
      let piece = pieces[i];
      if (!this.started) piece = piece.replace(/^\s+/, "");
      if (!piece) continue;
      for (; this.newlines > 0; this.newlines--) {
        out("\n");
        if (this.newlines > 1 && bar) out(c.dim(bar.trimEnd()));
        this.lineStart = true;
      }
      if (this.lineStart && bar) out(c.dim(bar));
      out(style(piece));
      this.started = true;
      this.lineStart = false;
    }
  }

  end() {
    this.clearPlaceholder();
    if (this.phase === "thinking" && !this.showThinking) out(c.dim(`Thought for ${fmtSecs(performance.now() - this.thinkingFrom)}`));
    if (this.started || (this.phase === "thinking" && !this.showThinking)) out("\n");
  }
}

// ------------------------------------------------------------------ the chat session

const state = {
  home: "",
  cfg: { ...DEFAULT_CONFIG },
  conn: null, // { url, key }
  info: null, // what /info said last
  chat: null,
  listed: [], // chat ids in the order /list showed them
  pending: { images: [], files: [] }, // attachments for the next message
  showThinking: true,
  levelsRejected: false, // the model takes think true/false, not levels
  running: null, // { controller } while a reply streams
  input: null,
  armed: false, // Ctrl+C was pressed once on an empty prompt
  saveWarned: false,
};

function persist(chat, { touch = true } = {}) {
  if (touch) chat.updated = Date.now();
  try {
    writeChat(state.home, chat);
  } catch (err) {
    if (!state.saveWarned) warn(`Couldn't save the chat in ${chatsDir(state.home)}: ${err.message}`);
    state.saveWarned = true;
  }
}

function saveSettings() {
  try {
    saveConfig(state.home, state.cfg);
  } catch (err) {
    warn(`Couldn't save the settings: ${err.message}`);
  }
}

function printHeader(info, { full = false } = {}) {
  say(c.bold(info.label || info.model));
  const where = [platformName(info.platform) + (gpuLabel(info) ? ` on ${gpuLabel(info)}` : ""), `${fmtTokens(info.num_ctx || 0)} context`, `pictures ${info.vision ? "on" : "off"}`];
  where.push(info.thinking ? `thinking: ${state.cfg.effort}` : "no thinking step");
  note(where.join("  ·  "));
  if (info.ends_in_s != null) note(`Session: ${fmtDuration(info.ends_in_s)} left${info.idle_minutes ? ` (it stops after ${info.idle_minutes} min idle)` : ""}`);
  if (full) {
    note(`Server: ${state.conn.url}`);
    if (info.source && info.source !== info.label) note(`Model: ${info.source}`);
    if (info.uptime_s != null) note(`Up for ${fmtDuration(info.uptime_s)}${info.busy ? ", answering someone right now" : ""}`);
    note(`Instructions for every chat: ${state.cfg.system.trim() ? `set (${plural(state.cfg.system.trim().length, "character")})` : "none"}`);
    note(`Chats are saved in ${chatsDir(state.home)}`);
  }
}

function helpText() {
  const rows = [
    ["/new", "start a new chat"],
    ["/list", "your chats, newest first"],
    ["/open N", "go back to chat N from the list"],
    ["/delete N", "delete chat N"],
    ["/title TEXT", "rename this chat"],
    ["/retry", "a new answer to your last message"],
    ["/think LEVEL", "off, quick, balanced or deep: how long it thinks first"],
    ["/think show|hide", "show or hide its reasoning"],
    ["/system TEXT", "instructions it follows in every chat (/system alone clears them)"],
    ["/image PATH", state.info?.vision ? "attach a picture (PNG, JPEG, WebP or GIF, up to 5 MB)" : "attach a picture (this model can't see pictures)"],
    ["/file PATH", "attach a text file (up to 400 KB)"],
    ["/info", "what the server runs and how long the session has left"],
    ["/connect LINK", "switch to another server (or /connect URL KEY)"],
    ["/shutdown", "stop the notebook and free the GPU"],
    ["/exit", "quit (Ctrl+D, or Ctrl+C twice, also works)"],
  ];
  return [
    'Enter sends. End a line with \\ to keep typing on the next one, or put several lines between two lines of """.',
    "",
    ...rows.map(([name, what]) => `  ${name.padEnd(18)}${what}`),
    "",
    "Ctrl+C while it's answering stops the answer and keeps what it wrote so far.",
    "To send a line that starts with /, start it with // instead.",
  ].join("\n");
}

async function ask(question) {
  const item = await state.input.take(question);
  if (item?.cancel && state.input.terminal) out("\n");
  return Boolean(item?.line !== undefined && /^\s*y(es)?\s*$/i.test(item.line));
}

/** One message: a line, lines joined with a trailing \, a """ block, or a paste. */
async function readMessage() {
  const input = state.input;
  let parts = [];
  let mode = ""; // "" | "more" (after a \) | "block" | "paste"
  for (;;) {
    const item = await input.take(parts.length || mode ? MORE_PROMPT : MAIN_PROMPT);
    if (!item) return parts.length ? { text: parts.join("\n") } : null;
    if (item.cancel) {
      if (parts.length || mode) {
        parts = [];
        mode = "";
        out((input.terminal ? "\n" : "") + c.dim("Cancelled.") + "\n");
      } else if (item.hadText) {
        state.armed = false;
      } else {
        if (state.armed) {
          if (input.terminal) out("\n");
          return { exit: true };
        }
        state.armed = true;
        out((input.terminal ? "\n" : "") + c.dim("Press Ctrl+C again to quit, or type /exit.") + "\n");
      }
      continue;
    }
    state.armed = false;
    const line = item.line;
    if (mode === "block") {
      if (line.trim() === '"""') return { text: parts.join("\n") };
      parts.push(line);
      continue;
    }
    if (!parts.length && !mode && line.trim() === '"""') {
      mode = "block";
      continue;
    }
    if ((await input.pastedWith(item)) || (mode === "paste" && input.hasDraft())) {
      parts.push(line); // pasted text is kept as it is, backslashes and all
      mode = "paste";
      continue;
    }
    if (mode !== "paste" && line.endsWith("\\")) {
      parts.push(line.slice(0, -1));
      mode = "more";
      continue;
    }
    parts.push(line);
    return { text: parts.join("\n") };
  }
}

async function chatLoop() {
  for (;;) {
    const message = await readMessage();
    if (!message || message.exit) return 0;
    const text = message.text;
    if (text.trimStart().startsWith("/") && !text.trimStart().startsWith("//") && !text.trim().includes("\n")) {
      if ((await command(text.trim())) === "exit") return 0;
      continue;
    }
    await send(text.trimStart().startsWith("//") ? text.trimStart().slice(1) : text);
  }
}

async function send(raw) {
  const text = raw.trim();
  const { images, files } = state.pending;
  if (!text && !images.length && !files.length) return;
  let chat = state.chat;
  if (!chat) {
    chat = state.chat = { id: uid(), title: "", created: Date.now(), updated: Date.now(), messages: [] };
  }
  chat.messages.push({ id: uid(), role: "user", content: text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), at: Date.now() });
  if (!chat.title) chat.title = titleFrom(text || files[0]?.name || "");
  state.pending = { images: [], files: [] };
  await reply(chat);
}

async function post(path_, body, signal) {
  return fetch(state.conn.url + path_, {
    method: "POST",
    headers: { ...auth(state.conn.key), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function reply(chat) {
  const info = state.info;
  const answer = { id: uid(), role: "assistant", content: "", thinking: "", at: Date.now(), effort: info.thinking ? state.cfg.effort : null };
  chat.messages.push(answer);
  persist(chat);
  const controller = new AbortController();
  state.running = { controller };

  const { messages, dropped } = buildContext(chat.messages.slice(0, -1), { numCtx: info.num_ctx, system: state.cfg.system, vision: info.vision });
  const options = {};
  const temperature = state.cfg.temperature;
  if (temperature !== "" && temperature !== null && temperature !== undefined && !Number.isNaN(Number(temperature))) options.temperature = Number(temperature);
  let think = thinkValue(state.cfg.effort, { thinking: Boolean(info.thinking), levelsRejected: state.levelsRejected });
  const printer = new ReplyPrinter({ showThinking: state.showThinking });
  printer.start();
  const started = performance.now();
  let firstAt = 0, thinkStart = 0, answerAt = 0, chunks = 0, thinkChunks = 0, final = null, lastSave = Date.now();

  const handle = (part) => {
    if (part.error) throw new Error(String(part.error));
    const m = part.message || {};
    const now = performance.now();
    if (m.thinking) {
      if (!firstAt) firstAt = now;
      if (!thinkStart) thinkStart = now;
      answer.thinking += m.thinking;
      thinkChunks++;
    }
    if (m.content) {
      if (!firstAt) firstAt = now;
      if (!answerAt) answerAt = now;
      answer.content += m.content;
      chunks++;
    }
    if (part.done) final = part;
    printer.update(answer);
    if (Date.now() - lastSave > 3000) {
      lastSave = Date.now();
      persist(chat);
    }
  };

  try {
    const body = () => ({ model: info.model, messages, stream: true, ...(think !== undefined ? { think } : {}), ...(Object.keys(options).length ? { options } : {}) });
    let res = await post("/api/chat", body(), controller.signal);
    if (res.status === 400 && think !== undefined) {
      const detail = await res.text();
      if (!/think/i.test(detail)) throw new Error(errorText(detail, 400));
      if (typeof think === "string") state.levelsRejected = true;
      think = typeof think === "string" ? true : undefined; // this model takes thinking on or off, not levels
      if (/not support/i.test(detail)) {
        think = undefined;
        info.thinking = false;
      }
      res = await post("/api/chat", body(), controller.signal);
    }
    if (res.status === 401) throw new Error("The server didn't accept the key. Use /connect with the newest link from the notebook.");
    if (!res.ok) throw new Error(errorText(await res.text(), res.status));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
    if (buffer.trim()) handle(JSON.parse(buffer));
    if (!final) throw new Error("The reply was cut off: the server's session may have ended.");
  } catch (err) {
    if (controller.signal.aborted) answer.stopped = true;
    else answer.error = err instanceof TypeError ? OFFLINE_REPLY : String(err.message || err);
  } finally {
    const end = performance.now();
    const tokens = final?.eval_count ?? chunks + thinkChunks;
    const genSeconds = final?.eval_duration ? final.eval_duration / 1e9 : (end - (firstAt || end)) / 1000;
    answer.stats = {
      tokens,
      tps: genSeconds > 0.2 ? tokens / genSeconds : null,
      prompt_tokens: final?.prompt_eval_count ?? null,
      first_token_ms: firstAt ? Math.round(firstAt - started) : null,
      thinking_ms: thinkStart ? Math.round((answerAt || end) - thinkStart) : null,
      thinking_tokens: thinkChunks || null,
      num_ctx: info.num_ctx ?? null,
      dropped: dropped > 0 ? dropped : 0,
    };
    if (!answer.content && !answer.thinking && !answer.error && !answer.stopped) answer.error = "The model sent an empty reply.";
    state.running = null;
    printer.update(answer, true);
    printer.end();
    if (answer.error) say(c.red(answer.error));
    printReadings(answer);
    out("\n");
    persist(chat);
  }
}

// ------------------------------------------------------------------ commands

function chatNumber(arg) {
  if (!state.listed.length) state.listed = loadChats(state.home).map((chat) => chat.id);
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > state.listed.length) {
    say(state.listed.length ? `Pick a number from 1 to ${state.listed.length} (see /list).` : "There are no saved chats yet.");
    return null;
  }
  const id = state.listed[n - 1];
  const chat = loadChats(state.home).find((x) => x.id === id);
  if (!chat) say("That chat isn't there any more. /list shows what's left.");
  return chat || null;
}

function showMessage(m) {
  if (m.role === "user") {
    const extras = [...(m.files || []).map((f) => `file: ${f.name}`), ...(m.images || []).map((img) => `picture: ${img.name}`)];
    say(c.violet(MAIN_PROMPT) + m.content.split("\n").join("\n" + " ".repeat(MAIN_PROMPT.length)));
    if (extras.length) note("  " + extras.join(", "));
    return;
  }
  const { content } = splitThinking(m);
  if (content.trim()) say(content.trim());
  if (m.error) say(c.red(m.error));
  printReadings(m);
  out("\n");
}

async function command(line) {
  const [, name, rest = ""] = line.match(/^(\/\S*)\s*([\s\S]*)$/) || [];
  const arg = rest.trim();
  switch (name.toLowerCase()) {
    case "/help":
    case "/?":
      say(helpText());
      return;
    case "/exit":
    case "/quit":
      return "exit";
    case "/new":
      state.chat = null;
      say("New chat. Type your first message.");
      return;
    case "/list": {
      const chats = loadChats(state.home);
      state.listed = chats.map((chat) => chat.id);
      if (!chats.length) return say("No saved chats yet.");
      say("Your chats, newest first:");
      chats.forEach((chat, k) => {
        const title = (chat.title || "New chat").replace(/\s+/g, " ");
        const shown = title.length > 44 ? title.slice(0, 43) + "…" : title;
        const current = state.chat?.id === chat.id ? c.violet("  (open)") : "";
        say(`  ${String(k + 1).padStart(3)}  ${shown.padEnd(44)}  ${c.dim(`${plural(chat.messages.length, "message")}, ${ago(chat.updated)}`)}${current}`);
      });
      note("/open N goes back to one.");
      return;
    }
    case "/open": {
      const chat = chatNumber(arg);
      if (!chat) return;
      state.chat = chat;
      say(`Opened "${chat.title || "New chat"}" (${plural(chat.messages.length, "message")}).`);
      out("\n");
      const recent = chat.messages.slice(-10);
      if (chat.messages.length > recent.length) note(`(${plural(chat.messages.length - recent.length, "earlier message")} not shown)`);
      recent.forEach(showMessage);
      return;
    }
    case "/delete": {
      const chat = chatNumber(arg);
      if (!chat) return;
      if (!(await ask(`Delete "${chat.title || "New chat"}" for good? [y/N] `))) return say("Kept it.");
      deleteChatFile(state.home, chat);
      state.listed = state.listed.filter((id) => id !== chat.id);
      if (state.chat?.id === chat.id) state.chat = null;
      say("Deleted. The numbers in /list have moved up.");
      return;
    }
    case "/title":
      if (!state.chat) return say("There's no chat to rename yet. Send a message first.");
      if (!arg) return say(`This chat is called "${state.chat.title || "New chat"}". /title TEXT renames it.`);
      state.chat.title = arg.slice(0, 120);
      persist(state.chat);
      say(`Renamed to "${state.chat.title}".`);
      return;
    case "/retry": {
      const chat = state.chat;
      if (!chat || !chat.messages.some((m) => m.role === "user")) return say("Nothing to retry yet.");
      if (chat.messages[chat.messages.length - 1]?.role === "assistant") chat.messages.pop();
      await reply(chat);
      return;
    }
    case "/think":
      return thinkCommand(arg.toLowerCase());
    case "/system":
      state.cfg.system = arg;
      saveSettings();
      say(arg ? "Got it. It follows those instructions from your next message on, in every chat." : "Instructions cleared.");
      return;
    case "/image":
      return attachImage(arg);
    case "/file":
      return attachFile(arg);
    case "/info": {
      const result = await getInfo(state.conn);
      if (!result.ok) return warn(explainFailure(result, state.conn));
      state.info = result.info;
      printHeader(state.info, { full: true });
      return;
    }
    case "/connect":
      return connectCommand(rest);
    case "/shutdown": {
      if (!(await ask("Shut the server down? The notebook stops and the GPU is freed. [y/N] "))) return say("It's still running.");
      try {
        const res = await fetch(state.conn.url + "/shutdown", { method: "POST", headers: auth(state.conn.key), signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
        if (!res.ok) throw new Error(errorText(await res.text(), res.status));
      } catch (err) {
        return warn(err instanceof TypeError || err.name === "TimeoutError" ? "Couldn't reach the server. It may have stopped already." : `Couldn't shut it down: ${err.message}`);
      }
      say("The server is shutting down. Run the notebook again when you want to chat; your chats stay here.");
      return "exit";
    }
    default:
      say(`There's no ${name} command. /help lists them.`);
  }
}

function thinkCommand(arg) {
  const thinks = Boolean(state.info?.thinking);
  if (!arg) {
    if (!thinks) return say("This model answers straight away; it has no thinking step.");
    say(`Thinking: ${state.cfg.effort} (${EFFORTS[state.cfg.effort].note}), reasoning ${state.showThinking ? "shown" : "hidden"}.`);
    return note("Change it with /think off, quick, balanced or deep, and /think show or hide.");
  }
  if (arg === "show" || arg === "hide") {
    state.showThinking = arg === "show";
    return say(state.showThinking ? "Its reasoning is shown, dimmed, before each answer." : "Its reasoning is hidden; you'll see how long it thought.");
  }
  if (!EFFORTS[arg]) return say("Use /think off, quick, balanced or deep (or /think show or hide).");
  state.cfg.effort = arg;
  saveSettings();
  say(`Thinking: ${arg}, ${EFFORTS[arg].note}.` + (thinks ? "" : " This model has no thinking step, so it only matters with a model that does."));
}

function readAttachment(arg, what) {
  if (!arg) {
    say(`Give the path: /${what} PATH`);
    return null;
  }
  const file = expandPath(arg);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    say(`Couldn't find ${unquote(arg)}.`);
    return null;
  }
  if (!stat.isFile()) {
    say(`${unquote(arg)} is a folder, not a file.`);
    return null;
  }
  return { file, name: path.basename(file), size: stat.size };
}

function attachImage(arg) {
  if (!state.info?.vision) return say("This model can't see pictures, so /image doesn't work with it.");
  const found = readAttachment(arg, "image");
  if (!found) return;
  if (found.size > MAX_IMAGE_BYTES) return say(`${found.name} is too big: pictures can be up to 5 MB.`);
  if (state.pending.images.length >= MAX_IMAGES) return say(`Up to ${MAX_IMAGES} pictures per message.`);
  const buf = fs.readFileSync(found.file);
  if (!sniffImage(buf)) return say(`${found.name} isn't a PNG, JPEG, WebP or GIF picture.`);
  state.pending.images.push({ name: found.name, data: buf.toString("base64") });
  say(`Attached ${found.name} (${fmtBytes(found.size)}). It goes with your next message.`);
}

function attachFile(arg) {
  const found = readAttachment(arg, "file");
  if (!found) return;
  if (found.size > MAX_TEXT_FILE) return say(`${found.name} is too big: text files can be up to 400 KB.`);
  const buf = fs.readFileSync(found.file);
  if (looksBinary(buf)) return say(`${found.name} isn't a text file.`);
  state.pending.files.push({ name: found.name, text: buf.toString("utf8").replace(/^﻿/, "") });
  say(`Attached ${found.name} (${fmtBytes(found.size)}). It goes with your next message.`);
}

async function connectCommand(rest) {
  const target = parseConnect(rest);
  if (!target.url || !target.key) return say("Paste the notebook's link: /connect LINK (or /connect URL KEY).");
  const result = await getInfo(target);
  if (!result.ok) return warn(explainFailure(result, target) + "\nStill using the server you had.");
  state.conn = target;
  state.info = result.info;
  state.levelsRejected = false;
  state.cfg.server = target.url;
  state.cfg.key = target.key;
  saveSettings();
  say("Connected.");
  printHeader(state.info);
}

// ------------------------------------------------------------------ start-up

function usageText(home) {
  return [
    "Chat in this terminal with the model your Kaggle or Colab notebook is running.",
    "",
    '  node chat.mjs "<link>"                  connect with the link the notebook printed',
    "  node chat.mjs --server URL --key KEY    connect with the address and key",
    "  node chat.mjs                           connect to the last server again",
    "  node chat.mjs --export FILE             save all your chats to a file",
    "  node chat.mjs --import FILE             add the chats from an export",
    "",
    "Put the link in quotes: the & and # in it mean something to your shell.",
    "Exports work both ways with the web app (Settings, then Your chats).",
    "",
    `Settings and chats are kept in ${home}`,
    "(set NO_GPU_HOME to use another folder). Type /help once connected for the chat commands.",
    "",
  ].join("\n");
}

function finish(code) {
  state.input?.close();
  process.exitCode = code;
  // Exit by running out of work: process.exit() while a socket the server just closed is still
  // closing aborts Node on Windows (UV_HANDLE_CLOSING). The fallback only fires if something keeps
  // the process alive, and by then that socket is long closed.
  setTimeout(() => process.exit(code), 4500).unref();
}

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\nnode chat.mjs --help shows how to use it.\n`);
    return 2;
  }
  const home = homeDir();
  if (args.help) {
    out(usageText(home));
    return 0;
  }
  if (args.importFile || args.exportFile) {
    if (args.importFile) {
      const code = importChats(home, args.importFile);
      if (code) return code;
    }
    return args.exportFile ? exportChats(home, args.exportFile) : 0;
  }

  const cfg = loadConfig(home);
  let target;
  try {
    target = resolveTarget(args, cfg);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(err.message + "\n");
    return 2;
  }
  if (!target) {
    process.stderr.write(
      'There\'s no server saved yet. Run the notebook, then start this with the link it prints:\n  node chat.mjs "<the link>"\n' +
        "(node chat.mjs --help shows the other ways.)\n",
    );
    return 2;
  }
  const result = await getInfo(target);
  if (!result.ok) {
    process.stderr.write(explainFailure(result, target) + "\n");
    return 1;
  }

  Object.assign(state, { home, cfg, conn: target, info: result.info });
  if (cfg.server !== target.url || cfg.key !== target.key) {
    cfg.server = target.url;
    cfg.key = target.key;
    saveSettings();
  }
  printHeader(state.info);
  const saved = loadChats(home).length;
  note(`Type a message and press Enter. /help shows the commands${saved ? `, /list your ${plural(saved, "saved chat")}` : ""}.`);
  out("\n");

  state.input = new Input();
  state.input.onInterrupt = () => {
    if (state.running) return state.running.controller.abort();
    if (!state.input.atPrompt) return;
    const hadText = state.input.clearDraft();
    state.input.push({ cancel: true, hadText });
  };
  process.stdout.on("error", () => process.exit(0)); // the reader went away (a closed pipe)
  const code = await chatLoop();
  if (state.input.terminal && state.input.closed) out("\n");
  return code;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    let self = decodeURIComponent(new URL(import.meta.url).pathname);
    if (process.platform === "win32") self = self.replace(/^\/([A-Za-z]:)/, "$1");
    if (path.basename(process.argv[1]) === path.basename(self)) return true;
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(path.resolve(self));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => finish(code ?? 0),
    (err) => {
      process.stderr.write(`Something went wrong: ${err?.stack || err}\n`);
      finish(1);
    },
  );
}
