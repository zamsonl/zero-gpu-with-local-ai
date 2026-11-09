// Local stack for tests: mock Ollama + `wrangler dev` on isolated D1 state, with the mock registered.
//
//   node test/dev-stack.mjs --port 8800 --mock-port 11500 --state .test-state/dev
//        [--auth key] [--var NAME:value]... [--no-register] [--parent-pid <pid>]
//
// Prints `READY http://127.0.0.1:<port>` once it serves, then runs until SIGINT/SIGTERM or until the
// --parent-pid process exits. Programmatic use (preferred):
//
//   const stack = await startStack({ port, mockPort, state, auth });
//   try { ... stack.url, stack.mock ... } finally { await stack.stop(); }
//
// Several stacks can run at once as long as ports and state directories differ. Relative state
// paths resolve against worker/. Every child process is tracked and its whole tree is killed on
// stop (taskkill /T on Windows); nothing here ever re-runs this script.

import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startMockOllama } from "./mock-ollama.mjs";

export const RELAY_KEY = "test-relay-key-0123456789";
export const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER_JS = path.join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const TARGET_PATTERN = "^http://127\\.0\\.0\\.1:\\d+$";
const READY_TIMEOUT_MS = 90_000;
const IS_WINDOWS = process.platform === "win32";

const liveChildren = new Set();

// Last-resort cleanup if the hosting process exits without calling stop().
process.on("exit", () => {
  for (const child of liveChildren) killTreeSync(child.pid);
});

/**
 * @param {object} o
 * @param {number} o.port        worker port (the inspector uses port + 1000)
 * @param {number} o.mockPort    mock Ollama port
 * @param {string} o.state       persist directory for D1 (relative to worker/ or absolute)
 * @param {"open"|"key"} [o.auth]
 * @param {Record<string,string>} [o.vars]  extra worker vars, e.g. { TIMING_SCALE: "0.05" }
 * @param {boolean} [o.register] register the mock as the Colab target (default true)
 * @param {(line: string) => void} [o.log] receives wrangler's output lines
 */
export async function startStack({ port, mockPort, state, auth = "open", vars = {}, register = true, log } = {}) {
  if (!port || !mockPort || !state) throw new Error("startStack needs port, mockPort and state");
  const stateDir = path.resolve(WORKER_DIR, state);
  fs.mkdirSync(stateDir, { recursive: true });
  const url = `http://127.0.0.1:${port}`;
  const output = new OutputTail(log);
  const mock = await startMockOllama({ port: mockPort });
  let devServer = null;

  const stop = once1(async () => {
    if (devServer) await killTree(devServer);
    await mock.close();
  });

  try {
    await runWrangler(["d1", "migrations", "apply", "qwen-chats", "--local", "--persist-to", stateDir], stateDir, output);

    const workerVars = { RELAY_KEY, TARGET_PATTERN, AUTH_MODE: auth, COLAB_URL: "https://colab.research.google.com/drive/EXAMPLE_NOTEBOOK_ID", ...vars };
    devServer = spawnWrangler(
      [
        "dev",
        "--ip", "127.0.0.1",
        "--port", String(port),
        "--inspector-port", String(port + 1000),
        "--persist-to", stateDir,
        "--show-interactive-dev-session=false",
        ...Object.entries(workerVars).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
      ],
      stateDir,
      output,
    );
    await waitUntilServing(url, devServer, output);

    if (register) {
      const res = await fetch(`${url}/_relay/register`, {
        method: "POST",
        headers: { "x-relay-key": RELAY_KEY, "content-type": "application/json" },
        body: JSON.stringify({ target: mock.url }),
      });
      if (!res.ok) throw new Error(`registering the mock failed: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    url,
    mock,
    relayKey: RELAY_KEY,
    stateDir,
    /** Runs SQL on the stack's local D1 (works while wrangler dev is up); resolves to the result rows. */
    sql: async (command) => {
      const stdout = await runWrangler(
        ["d1", "execute", "qwen-chats", "--local", "--persist-to", stateDir, "--json", "--command", command],
        stateDir,
        output,
      );
      return JSON.parse(stdout).flatMap((statement) => statement.results ?? []);
    },
    output: () => output.text(),
    stop,
  };
}

function spawnWrangler(args, stateDir, output) {
  const child = spawn(process.execPath, [WRANGLER_JS, ...args], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: path.join(stateDir, "logs"),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CI: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: !IS_WINDOWS, // own process group, so the whole tree can be signalled on POSIX
  });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  child.stdout.on("data", (data) => output.push(data));
  child.stderr.on("data", (data) => output.push(data));
  return child;
}

/** Runs a short-lived wrangler command to completion and resolves to its stdout. */
async function runWrangler(args, stateDir, output) {
  const child = spawnWrangler(args, stateDir, output);
  let stdout = "";
  child.stdout.on("data", (data) => (stdout += data));
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} exited with ${code}\n${output.text()}`);
  return stdout;
}

async function waitUntilServing(url, child, output) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited with ${child.exitCode}\n${output.text()}`);
    try {
      const res = await fetch(`${url}/_relay/status`, {
        headers: { "x-relay-key": RELAY_KEY },
        signal: AbortSignal.timeout(2000),
      });
      await res.body?.cancel();
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error(`wrangler dev did not serve ${url} within ${READY_TIMEOUT_MS / 1000} s\n${output.text()}`);
}

async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  let treePids = [child.pid];
  if (IS_WINDOWS) {
    // taskkill names every process it terminates; wait for all of them (workerd outlives wrangler
    // by a moment and holds the persist directory open until it is gone).
    const report = await new Promise((resolve) =>
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], (_, stdout) => resolve(stdout ?? "")),
    );
    // "SUCCESS: The process with PID <killed> (child process of PID <parent>) has been terminated."
    treePids = report
      .split(/\r?\n/)
      .map((line) => Number(line.match(/PID (\d+)/)?.[1]))
      .filter(Boolean);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.race([exited, delay(15_000)]);
  const deadline = Date.now() + 15_000;
  while (treePids.some(processExists) && Date.now() < deadline) await delay(100);
}

function killTreeSync(pid) {
  try {
    if (IS_WINDOWS) execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Keeps the last lines of wrangler's output for error messages, optionally forwarding them. */
class OutputTail {
  #lines = [];
  #partial = "";

  constructor(log) {
    this.log = log;
  }

  push(data) {
    const parts = (this.#partial + data.toString()).split(/\r?\n/);
    this.#partial = parts.pop();
    for (const line of parts) {
      this.log?.(line);
      this.#lines.push(line);
    }
    if (this.#lines.length > 200) this.#lines.splice(0, this.#lines.length - 200);
  }

  text() {
    return [...this.#lines, this.#partial].join("\n");
  }
}

function once1(fn) {
  let promise = null;
  return () => (promise ??= fn());
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "8800" },
      "mock-port": { type: "string", default: "11500" },
      state: { type: "string", default: ".test-state/dev" },
      auth: { type: "string", default: "open" },
      var: { type: "string", multiple: true, default: [] },
      "no-register": { type: "boolean", default: false },
      "parent-pid": { type: "string" },
    },
  });
  if (!["open", "key"].includes(values.auth)) throw new Error('--auth must be "open" or "key"');
  const vars = Object.fromEntries(
    values.var.map((pair) => {
      const at = pair.indexOf(":");
      if (at < 1) throw new Error(`--var expects NAME:value, got "${pair}"`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );

  const stack = await startStack({
    port: Number(values.port),
    mockPort: Number(values["mock-port"]),
    state: values.state,
    auth: values.auth,
    vars,
    register: !values["no-register"],
  });
  console.log(`READY ${stack.url}`);

  const shutdown = () => stack.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (values["parent-pid"]) {
    const parentPid = Number(values["parent-pid"]);
    setInterval(() => {
      if (!processExists(parentPid)) shutdown();
    }, 2000);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
