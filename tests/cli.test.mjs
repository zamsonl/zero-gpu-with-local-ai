// Tests for cli/chat.mjs: the real gatekeeper in front of the mock Ollama (tests/dev_server.py),
// with the client driven through piped stdin. Run from the repository root:
//
//   node --test tests/cli.test.mjs
//
// Every run gets a fresh NO_GPU_HOME in the system temp folder, and every dev server is started on
// --port 0; all of them are removed or stopped at the end.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAT = path.join(ROOT, "cli", "chat.mjs");
const DEV_SERVER = path.join(ROOT, "tests", "dev_server.py");
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const LABEL = "Qwen 3.8 27B Uncensored (Q5_K_P)";
const REPLY_START = "Here's a small script that does it.";
const REPLY_END = "Run it on a copy first.";
const THINKING = "The user wants a script.";
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const READINGS = /\d+\.\d tok\/s {2}\d+ tokens {2}first token \d+\.\d s/;

const lib = await import(pathToFileURL(CHAT).href);

const temps = new Set();
const children = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(label = "home") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ngla-cli-${label}-`));
  temps.add(dir);
  return dir;
}

/** Starts tests/dev_server.py on a free port. Returns { url, key, link, stop() }. */
async function startServer(...flags) {
  const key = "k-" + crypto.randomBytes(9).toString("hex");
  const proc = spawn(PYTHON, ["-u", DEV_SERVER, "--port", "0", "--key", key, ...flags], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  children.add(proc);
  const exited = new Promise((resolve) => proc.on("exit", () => (children.delete(proc), resolve())));
  let text = "";
  const [, url, link] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev_server.py didn't start:\n${text}`)), 20_000);
    const read = (chunk) => {
      text += chunk;
      const found = text.match(/Mock server: (\S+) +key: \S+\r?\nOpen: (\S+)\r?\n/);
      if (found) {
        clearTimeout(timer);
        resolve(found);
      }
    };
    proc.stdout.on("data", read);
    proc.stderr.on("data", read);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dev_server.py exited with ${code}:\n${text}`));
    });
  });
  return {
    url,
    key,
    link,
    proc,
    exited,
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try {
        await fetch(url + "/shutdown", { method: "POST", headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
      } catch {}
      const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!done) {
        proc.kill();
        await exited;
      }
    },
  };
}

function chatEnv(home, extra = {}) {
  const env = { ...process.env, NO_GPU_HOME: home, NO_COLOR: "1", ...extra };
  if (!("NO_GPU_TERMINAL" in extra)) delete env.NO_GPU_TERMINAL;
  return env;
}

/** Starts chat.mjs with piped stdin; the caller writes lines and waits for output. */
function startChat(home, args = [], extraEnv = {}) {
  const child = spawn(process.execPath, [CHAT, ...args], { cwd: ROOT, env: chatEnv(home, extraEnv), stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.on("error", () => {}); // it may exit before reading everything
  const closed = new Promise((resolve) => child.on("close", (code, signal) => (children.delete(child), resolve({ code, signal }))));
  return {
    child,
    get stdout() {
      return stdout;
    },
    get output() {
      return stdout + stderr;
    },
    write: (text) => child.stdin.write(text),
    end: () => child.stdin.end(),
    async waitFor(pattern, ms = 20_000) {
      const started = Date.now();
      while (!pattern.test(stdout + stderr)) {
        if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${pattern}. Output so far:\n${stdout + stderr}`);
        if (child.exitCode !== null) throw new Error(`chat.mjs exited (${child.exitCode}) before ${pattern}. Output:\n${stdout + stderr}`);
        await sleep(20);
      }
    },
    async done(ms = 30_000) {
      const result = await Promise.race([closed, sleep(ms).then(() => null)]);
      if (!result) {
        child.kill();
        throw new Error(`chat.mjs didn't finish in ${ms} ms. Output:\n${stdout + stderr}`);
      }
      return { ...result, stdout, stderr, output: stdout + stderr };
    },
  };
}

/** Runs chat.mjs with all of `input` on stdin and waits for it to exit. */
async function runChat(home, args = [], input = "", extraEnv = {}) {
  const run = startChat(home, args, extraEnv);
  run.write(input);
  run.end();
  return run.done();
}

function readChats(home) {
  const dir = path.join(home, "chats");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))
    .sort((a, b) => a.created - b.created);
}

const readConfig = (home) => JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
const connect = (server) => ["--server", server.url, "--key", server.key];

function assertNoKey(result, ...keys) {
  for (const key of keys) assert.ok(!result.output.includes(key), `the key was printed:\n${result.output}`);
}

let shared; // the default dev server most tests talk to

before(async () => {
  shared = await startServer("--delay", "0.004");
});

after(async () => {
  await shared?.stop();
  for (const child of children) child.kill();
  await sleep(200);
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ connecting

test("connects and prints a short header", async () => {
  const home = tempDir();
  const result = await runChat(home, connect(shared));
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, new RegExp(LABEL.replace(/[()]/g, "\\$&")));
  assert.match(result.stdout, /Kaggle on 2× T4/);
  assert.match(result.stdout, /32K context/);
  assert.match(result.stdout, /pictures on/);
  assert.match(result.stdout, /thinking: balanced/);
  assert.match(result.stdout, /Session: 4\d min left \(it stops after 45 min idle\)/);
  assertNoKey(result, shared.key);
  const cfg = readConfig(home);
  assert.deepEqual(cfg, { server: shared.url, key: shared.key, effort: "balanced", system: "", temperature: "" });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(home, "config.json")).mode & 0o777, 0o600);
});

test("a wrong key exits non-zero and says how to fix it", async () => {
  const home = tempDir();
  const result = await runChat(home, ["--server", shared.url, "--key", "not-the-key"], "hello\n");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /didn't accept the key/);
  assert.match(result.stderr, /newest link/);
  assert.ok(!fs.existsSync(path.join(home, "config.json")), "a rejected key shouldn't be saved");
  assertNoKey(result, "not-the-key", shared.key);
});

test("a server that's gone says the session may have ended", async () => {
  const server = await startServer();
  await server.stop();
  const home = tempDir();
  const result = await runChat(home, connect(server), "hello\n");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Couldn't reach http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stderr, /session may have ended/);
  assert.match(result.stderr, /new link/);
  assertNoKey(result, server.key);
});

test("the server going away mid-chat gives a message, not a crash", async () => {
  const server = await startServer("--delay", "0.002");
  const home = tempDir();
  const run = startChat(home, connect(server));
  await run.waitFor(/Type a message/);
  await server.stop();
  run.write("are you still there?\n");
  run.end();
  const result = await run.done();
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /Couldn't reach the server\. Its session may have ended/);
  const [chat] = readChats(home);
  assert.match(chat.messages[1].error, /Couldn't reach the server/);
});

test("the whole link works as the argument, and the server is reused next time", async () => {
  const home = tempDir();
  assert.match(shared.link, /^file:.*#server=.*&key=/);
  const first = await runChat(home, [shared.link]);
  assert.equal(first.code, 0, first.output);
  assert.match(first.stdout, /32K context/);
  assert.equal(readConfig(home).server, shared.url);
  const again = await runChat(home, []);
  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout, /Kaggle on 2× T4/);
  assertNoKey(first, shared.key);
  assertNoKey(again, shared.key);

  const empty = await runChat(tempDir(), []);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /no server saved yet/);

  const cut = await runChat(tempDir(), [shared.link.split("&key=")[0]]);
  assert.equal(cut.code, 2);
  assert.match(cut.stderr, /no key in it/);
});

test("--help prints how to use it without a server", async () => {
  const home = tempDir();
  const result = await runChat(home, ["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--server URL --key KEY/);
  assert.match(result.stdout, /--export FILE/);
  assert.ok(result.stdout.includes(home), "it says where the chats are kept");
  const bad = await runChat(home, ["--bogus"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /There's no --bogus option/);
});

// ------------------------------------------------------------------ chatting

test("a reply streams in, with its reasoning and readings, and is saved under chats/", async () => {
  const home = tempDir();
  const result = await runChat(home, connect(shared), "Write a rename script\n");
  assert.equal(result.code, 0, result.output);
  assert.ok(result.stdout.includes("> Write a rename script"), "piped lines are echoed");
  assert.ok(result.stdout.includes("| " + THINKING), "the reasoning is shown first");
  assert.ok(result.stdout.indexOf(THINKING) < result.stdout.indexOf(REPLY_START));
  assert.ok(result.stdout.includes(REPLY_END));
  assert.match(result.stdout, READINGS);
  const chats = readChats(home);
  assert.equal(chats.length, 1);
  const [chat] = chats;
  assert.equal(chat.title, "Write a rename script");
  assert.equal(fs.readdirSync(path.join(home, "chats")).join(), `${chat.id}.json`);
  const [user, answer] = chat.messages;
  assert.deepEqual(Object.keys(user).sort(), ["at", "content", "id", "role"]);
  assert.equal(user.content, "Write a rename script");
  assert.equal(answer.role, "assistant");
  assert.ok(answer.content.startsWith(REPLY_START) && answer.content.includes(REPLY_END));
  assert.ok(answer.thinking.startsWith(THINKING));
  assert.equal(answer.effort, "balanced");
  assert.ok(answer.stats.tokens > 50 && answer.stats.tps > 0 && answer.stats.first_token_ms >= 0);
  assert.equal(answer.stats.num_ctx, 32768);
  assert.equal(answer.stopped, undefined);
  assert.equal(answer.error, undefined);
});

test("/think off asks for no reasoning; /think hide keeps it off the screen", async () => {
  const home = tempDir();
  const off = await runChat(home, connect(shared), "/think off\nhello\n");
  assert.equal(off.code, 0, off.output);
  assert.match(off.stdout, /Thinking: off, answers straight away/);
  assert.ok(!off.stdout.includes(THINKING));
  assert.ok(off.stdout.includes(REPLY_START));
  const [chat] = readChats(home);
  assert.equal(chat.messages[1].thinking, "");
  assert.equal(chat.messages[1].effort, "off");
  assert.equal(readConfig(home).effort, "off", "the level is remembered");

  const home2 = tempDir();
  const hidden = await runChat(home2, connect(shared), "/think hide\nhello\n");
  assert.ok(!hidden.stdout.includes(THINKING));
  assert.match(hidden.stdout, /Thought for \d+\.\d s/);
  assert.ok(readChats(home2)[0].messages[1].thinking.startsWith(THINKING), "it's still saved");
});

test("a model that rejects think levels is retried with think: true", async () => {
  const server = await startServer("--delay", "0.002", "--think-levels-rejected");
  try {
    const home = tempDir();
    const result = await runChat(home, connect(server), "/think quick\nhello\nand again\n");
    assert.equal(result.code, 0, result.output);
    assert.ok(!/invalid think value/.test(result.output), result.output);
    const [chat] = readChats(home);
    assert.equal(chat.messages.length, 4);
    for (const answer of [chat.messages[1], chat.messages[3]]) {
      assert.equal(answer.error, undefined);
      assert.ok(answer.content.includes(REPLY_END));
      assert.ok(answer.thinking.startsWith(THINKING), "think: true still thinks");
    }
  } finally {
    await server.stop();
  }
});

test("a model without a thinking step gets no think field and says so", async () => {
  const server = await startServer("--delay", "0.002", "--no-thinking");
  try {
    const home = tempDir();
    const result = await runChat(home, connect(server), "/think\nhello\n");
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /no thinking step/);
    assert.match(result.stdout, /answers straight away; it has no thinking step/);
    const answer = readChats(home)[0].messages[1];
    assert.equal(answer.effort, null);
    assert.equal(answer.thinking, "");
  } finally {
    await server.stop();
  }
});

test("long chats are trimmed to the newest messages that fit the context", async () => {
  const server = await startServer("--delay", "0.001", "--context", "2048");
  try {
    const home = tempDir();
    const long = (letter) => `${letter} `.repeat(1500).trim();
    const result = await runChat(home, connect(server), `${long("a")}\n${long("b")}\n`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /2K context/);
    assert.match(result.stdout, /1 older message left out to fit/);
    const [chat] = readChats(home);
    assert.equal(chat.messages[1].stats.dropped, 0);
    assert.equal(chat.messages[3].stats.dropped, 1);
  } finally {
    await server.stop();
  }
});

test('multi-line messages: a trailing backslash or a """ block', async () => {
  const home = tempDir();
  const input = 'line one\\\nline two\n"""\nblock a\n\nblock \\ b\n"""\n';
  const result = await runChat(home, connect(shared), input);
  assert.equal(result.code, 0, result.output);
  const users = readChats(home)[0].messages.filter((m) => m.role === "user");
  assert.deepEqual(users.map((m) => m.content), ["line one\nline two", "block a\n\nblock \\ b"]);
});

test("/new, /list and /open move between chats", async () => {
  const home = tempDir();
  const input = "first chat\n/new\nsecond chat\n/list\n/open 2\nback to the first\n/open 9\n";
  const result = await runChat(home, connect(shared), input);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /New chat\. Type your first message\./);
  assert.match(result.stdout, /Your chats, newest first:\s+1 {2}second chat\s+2 messages, just now {2}\(open\)\s+2 {2}first chat\s+2 messages, just now/);
  assert.match(result.stdout, /Opened "first chat" \(2 messages\)\./);
  assert.match(result.stdout, /Pick a number from 1 to 2/);
  const chats = readChats(home);
  assert.deepEqual(chats.map((c) => c.title), ["first chat", "second chat"]);
  assert.deepEqual(chats[0].messages.filter((m) => m.role === "user").map((m) => m.content), ["first chat", "back to the first"]);
  assert.equal(chats[1].messages.length, 2);
});

test("/title, /retry, /system and /delete", async () => {
  const home = tempDir();
  const input = "hello\n/title Greetings\n/retry\n/system Answer in French.\n/delete 1\nn\n/list\n/delete 1\ny\n/list\n";
  const result = await runChat(home, connect(shared), input);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /Renamed to "Greetings"\./);
  assert.match(result.stdout, /Kept it\./);
  assert.match(result.stdout, /1 {2}Greetings\s+2 messages/, "/retry replaced the answer instead of adding one");
  assert.match(result.stdout, /Deleted\./);
  assert.match(result.stdout, /No saved chats yet\./);
  assert.equal(readChats(home).length, 0);
  assert.equal(readConfig(home).system, "Answer in French.");
});

test("/file attaches a text file and refuses binary or big ones", async () => {
  const home = tempDir();
  const files = tempDir("files");
  const notes = path.join(files, "notes.txt");
  const binary = path.join(files, "blob.bin");
  const big = path.join(files, "big.txt");
  fs.writeFileSync(notes, "alpha beta gamma\n");
  fs.writeFileSync(binary, Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]));
  fs.writeFileSync(big, "x".repeat(400_001));
  const input = `/file "${binary}"\n/file ${big}\n/file ${path.join(files, "missing.txt")}\n/file "${notes}"\nsummarise this\n`;
  const result = await runChat(home, connect(shared), input);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /blob\.bin isn't a text file\./);
  assert.match(result.stdout, /big\.txt is too big: text files can be up to 400 KB\./);
  assert.match(result.stdout, /Couldn't find .*missing\.txt\./);
  assert.match(result.stdout, /Attached notes\.txt \(1 KB\)\. It goes with your next message\./);
  const [user, answer] = readChats(home)[0].messages;
  assert.equal(user.content, "summarise this");
  assert.deepEqual(user.files, [{ name: "notes.txt", text: "alpha beta gamma\n" }]);
  assert.ok(answer.content.includes(REPLY_END));
});

test("/image attaches a picture, and is refused when the model can't see", async () => {
  const files = tempDir("files");
  const picture = path.join(files, "dot.png");
  const notPicture = path.join(files, "fake.png");
  fs.writeFileSync(picture, PNG_1PX);
  fs.writeFileSync(notPicture, "just text");

  const home = tempDir();
  const result = await runChat(home, connect(shared), `/image ${notPicture}\n/image ${picture}\nwhat is this?\n`);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /fake\.png isn't a PNG, JPEG, WebP or GIF picture\./);
  assert.match(result.stdout, /Attached dot\.png/);
  const [user] = readChats(home)[0].messages;
  assert.deepEqual(user.images, [{ name: "dot.png", data: PNG_1PX.toString("base64") }]);

  const blind = await startServer("--delay", "0.002", "--no-vision");
  try {
    const home2 = tempDir();
    const refused = await runChat(home2, connect(blind), `/image ${picture}\nwhat is this?\n`);
    assert.equal(refused.code, 0, refused.output);
    assert.match(refused.stdout, /pictures off/);
    assert.match(refused.stdout, /This model can't see pictures, so \/image doesn't work with it\./);
    assert.equal(readChats(home2)[0].messages[0].images, undefined);
  } finally {
    await blind.stop();
  }
});

test("/connect switches servers without printing the key; a bad link keeps the old one", async () => {
  const other = await startServer("--delay", "0.002", "--context", "8192");
  try {
    const home = tempDir();
    const wrongKey = other.link.replace(/key=[^&]+/, "key=wrong");
    const result = await runChat(home, connect(shared), `/connect ${wrongKey}\n/connect ${other.link}\nhello\n`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /didn't accept the key[\s\S]*Still using the server you had\./);
    assert.match(result.stdout, /Connected\.[\s\S]*8K context/);
    assert.match(result.stdout, /\/connect http:\/\/127\.0\.0\.1:\d+ \(key hidden\)/);
    assert.equal(readConfig(home).server, other.url);
    assert.equal(readChats(home)[0].messages[1].stats.num_ctx, 8192);
    assertNoKey(result, shared.key, other.key);
  } finally {
    await other.stop();
  }
});

test("/shutdown asks first, then stops the server", async () => {
  const server = await startServer("--delay", "0.002");
  const home = tempDir();
  const result = await runChat(home, connect(server), "/shutdown\nn\n/shutdown\ny\nthis line is never read\n");
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /It's still running\./);
  assert.match(result.stdout, /The server is shutting down\./);
  assert.ok(!result.stdout.includes("> this line is never read"));
  const stopped = await Promise.race([server.exited.then(() => true), sleep(5000).then(() => false)]);
  assert.ok(stopped, "the dev server exits after /shutdown");
  await server.stop();
});

test("/exit quits straight away and later lines are ignored", async () => {
  const home = tempDir();
  const result = await runChat(home, connect(shared), "/help\n/exit\nhello\n");
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\/think show\|hide/);
  assert.equal(readChats(home).length, 0);
});

// ------------------------------------------------------------------ export and import

test("--export then --import round-trips the chats in the web app's format", async () => {
  const home = tempDir();
  await runChat(home, connect(shared), "first chat\n/new\nsecond chat\n");
  const files = tempDir("files");
  const exported = path.join(files, "chats.json");
  const exportRun = await runChat(home, ["--export", exported]);
  assert.equal(exportRun.code, 0, exportRun.output);
  assert.match(exportRun.stdout, /Saved 2 chats to /);
  const data = JSON.parse(fs.readFileSync(exported, "utf8"));
  assert.equal(data.app, "no-gpu-local-ai");
  assert.equal(data.version, 1);
  assert.equal(data.chats.length, 2);

  const home2 = tempDir();
  const importRun = await runChat(home2, ["--import", exported]);
  assert.equal(importRun.code, 0, importRun.output);
  assert.match(importRun.stdout, /Imported 2 chats\./);
  const byId = (chats) => [...chats].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(byId(readChats(home2)), byId(readChats(home)));
  const again = await runChat(home2, ["--import", exported]);
  assert.match(again.stdout, /Imported 2 chats \(2 replaced the copy already here\)\./);

  const back = path.join(files, "back.json");
  await runChat(home2, ["--export", back]);
  assert.deepEqual(byId(JSON.parse(fs.readFileSync(back, "utf8")).chats), byId(data.chats));

  // What the web app may hand over: odd ids stay inside chats/, junk messages are dropped.
  const odd = path.join(files, "odd.json");
  fs.writeFileSync(odd, JSON.stringify({ app: "no-gpu-local-ai", version: 1, chats: [{ id: "../../escape", title: "Odd", created: 1, updated: 2, messages: [{ role: "user", content: "hi" }, { role: "tool", content: "x" }, null] }, { nope: true }] }));
  const oddRun = await runChat(home2, ["--import", odd]);
  assert.match(oddRun.stdout, /Imported 1 chat\./);
  assert.ok(!fs.existsSync(path.join(home2, "..", "escape.json")));
  const imported = readChats(home2).find((c) => c.id === "../../escape");
  assert.deepEqual(imported.messages, [{ role: "user", content: "hi" }]);

  const notAnExport = path.join(files, "not.json");
  fs.writeFileSync(notAnExport, '{"hello": 1}');
  const bad = await runChat(home2, ["--import", notAnExport]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /isn't a chat export/);
});

// ------------------------------------------------------------------ stopping a reply

test("Ctrl+C (SIGINT) stops a reply and keeps the partial text", { skip: process.platform === "win32" && "Windows can't send SIGINT to a child process; the terminal-mode test below covers Ctrl+C there" }, async () => {
  const server = await startServer("--delay", "0.05");
  try {
    const home = tempDir();
    const run = startChat(home, connect(server));
    await run.waitFor(/Type a message/);
    run.write("hello\n");
    await run.waitFor(/small script/);
    run.child.kill("SIGINT");
    await run.waitFor(/stopped/);
    run.end();
    const result = await run.done();
    assert.equal(result.code, 0, result.output);
    const answer = readChats(home)[0].messages[1];
    assert.equal(answer.stopped, true);
    assert.ok(answer.content.startsWith("Here's") && !answer.content.includes(REPLY_END));
  } finally {
    await server.stop();
  }
});

test("in a terminal, Ctrl+C stops a reply, a paste is one message, and Ctrl+C twice quits", async () => {
  const server = await startServer("--delay", "0.05");
  try {
    const home = tempDir();
    const run = startChat(home, connect(server), { NO_GPU_TERMINAL: "1" });
    await run.waitFor(/Type a message/);
    run.write("hello there\n");
    await run.waitFor(/small script/);
    run.write("\x03"); // what a terminal sends for Ctrl+C
    await run.waitFor(/stopped/);
    await sleep(200);
    run.write("pasted one\npasted two\npasted three"); // a paste whose last line isn't finished yet
    await sleep(300);
    run.write("\n");
    await run.waitFor(/Run it on a copy first\.[\s\S]*tok\/s/);
    await sleep(200);
    run.write("\x03");
    await run.waitFor(/Press Ctrl\+C again to quit/);
    run.write("\x03");
    const result = await run.done();
    assert.equal(result.code, 0, result.output);
    const [stopped, user, answer] = readChats(home)[0].messages.slice(1);
    assert.equal(stopped.stopped, true);
    assert.ok(stopped.content.startsWith("Here's") && !stopped.content.includes(REPLY_END));
    assert.equal(user.content, "pasted one\npasted two\npasted three");
    assert.ok(answer.content.includes(REPLY_END) && !answer.stopped);
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------ the pieces, directly

test("links and arguments", () => {
  assert.deepEqual(lib.parseLink("https://zamsonl.github.io/no-gpu-local-ai/#server=https%3A%2F%2Fab-cd.trycloudflare.com&key=s3cr-et_"), { url: "https://ab-cd.trycloudflare.com", key: "s3cr-et_" });
  assert.deepEqual(lib.parseLink('"file:///x/index.html#server=http%3A%2F%2F127.0.0.1%3A9000&key=k"'), { url: "http://127.0.0.1:9000", key: "k" });
  assert.equal(lib.parseLink("https://ab-cd.trycloudflare.com"), null);
  assert.equal(lib.normaliseUrl("ab-cd.trycloudflare.com/info"), "https://ab-cd.trycloudflare.com");
  assert.equal(lib.normaliseUrl(""), "");
  assert.deepEqual(lib.parseArgs(["--server", "x.example", "--key", "-starts-with-dash"]).key, "-starts-with-dash");
  assert.equal(lib.parseArgs(["--key=abc"]).key, "abc");
  assert.throws(() => lib.parseArgs(["--key"]), /needs a value/);
  const cfg = { server: "https://saved.example", key: "saved-key" };
  assert.deepEqual(lib.resolveTarget(lib.parseArgs(["--server", "saved.example"]), cfg), { url: "https://saved.example", key: "saved-key" });
  assert.deepEqual(lib.resolveTarget(lib.parseArgs([]), cfg), { url: "https://saved.example", key: "saved-key" });
  assert.equal(lib.resolveTarget(lib.parseArgs([]), { server: "", key: "" }), null);
  assert.throws(() => lib.resolveTarget(lib.parseArgs(["--server", "other.example"]), cfg), /Add --key/);
});

test("think levels map the way the web app maps them", () => {
  assert.equal(lib.thinkValue("off"), false);
  assert.equal(lib.thinkValue("quick"), "low");
  assert.equal(lib.thinkValue("balanced"), "medium");
  assert.equal(lib.thinkValue("deep"), true);
  assert.equal(lib.thinkValue("quick", { levelsRejected: true }), true);
  assert.equal(lib.thinkValue("off", { levelsRejected: true }), false);
  assert.equal(lib.thinkValue("deep", { thinking: false }), undefined);
});

test("the context keeps the newest messages that fit, system prompt first", () => {
  const long = "x".repeat(3000);
  const history = [
    { role: "user", content: long },
    { role: "assistant", content: "<think>hmm</think>\n\nok" },
    { role: "assistant", content: "", thinking: "only thoughts" },
    { role: "user", content: long, images: [{ name: "a.png", data: "AAAA" }], files: [{ name: "n.txt", text: "note" }] },
  ];
  const trimmed = lib.buildContext(history, { numCtx: 2048, system: "Be brief.", vision: false });
  assert.equal(trimmed.dropped, 1);
  assert.deepEqual(trimmed.messages.map((m) => m.role), ["system", "assistant", "user"]);
  assert.equal(trimmed.messages[1].content, "ok");
  assert.ok(trimmed.messages[2].content.startsWith("File: n.txt\n```\nnote\n```\n\n"));
  assert.equal(trimmed.messages[2].images, undefined, "no pictures for a model that can't see");
  const seeing = lib.buildContext(history, { numCtx: 2048, vision: true });
  assert.deepEqual(seeing.messages.at(-1).images, ["AAAA"]);
  assert.equal(seeing.messages.length, 1, "a picture costs 800 tokens");
  const huge = lib.buildContext([{ role: "user", content: "y".repeat(100_000) }], { numCtx: 2048 });
  assert.equal(huge.messages.length, 1, "the newest message always goes");
});

test("thinking tags, readings, file names and picture types", () => {
  assert.deepEqual(lib.liveSplit({ content: "<thi" }), { thinking: "", content: "" });
  assert.deepEqual(lib.liveSplit({ content: "<b>bold" }), { thinking: "", content: "<b>bold" });
  assert.deepEqual(lib.liveSplit({ content: "<think>abc</th" }), { thinking: "", content: "" });
  assert.deepEqual(lib.liveSplit({ content: "<think>abc</th" }, true), { thinking: "abc</th", content: "" });
  assert.deepEqual(lib.liveSplit({ content: "<think>abc</think>\n\nHi" }), { thinking: "abc", content: "Hi" });
  assert.equal(lib.readings({ stats: { tps: 11.34, tokens: 512, first_token_ms: 1200 } }), "11.3 tok/s  512 tokens  first token 1.2 s");
  assert.equal(lib.readings({ stats: { tokens: 3, first_token_ms: 80, dropped: 2 }, stopped: true }), "3 tokens  first token 0.1 s  stopped  2 older messages left out to fit");
  assert.equal(lib.chatFileName("mvbz588mr1z0pr"), "mvbz588mr1z0pr.json");
  assert.match(lib.chatFileName("../../etc/passwd"), /^x-[0-9a-f]{32}\.json$/);
  assert.equal(lib.sniffImage(PNG_1PX), "image/png");
  assert.equal(lib.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(lib.sniffImage(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(lib.sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(lib.sniffImage(Buffer.from("hello")), null);
  assert.equal(lib.gpuLabel({ gpus: ["Tesla T4", "Tesla T4"] }), "2× T4");
  assert.equal(lib.gpuLabel({ gpus: ["NVIDIA L4"] }), "L4");
  assert.equal(lib.titleFrom("\n  first line\nsecond"), "first line");
});
