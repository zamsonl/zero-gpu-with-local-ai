// No Kaggle credentials, network, local Worker, or Python model execution required.
// Run: node --test test/kaggle-cache.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { test } from "node:test";

register("./python-text-loader.mjs", import.meta.url);
const { cacheDataSources, serverScript, startServer, kaggleBatch, kaggleProfile } = await import("../src/kaggle.js");

function memoryDb(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    rows,
    prepare(sql) {
      return {
        async run() {
          assert.equal(sql, "DELETE FROM state WHERE k = 'server_log:kaggle'");
          return { meta: { changes: rows.delete("server_log:kaggle") ? 1 : 0 } };
        },
        bind(...values) {
          return {
            async first() {
              assert.match(sql, /^SELECT v FROM state WHERE k = \?1$/);
              return rows.has(values[0]) ? { v: rows.get(values[0]) } : null;
            },
            async run() {
              assert.match(sql.trimStart(), /^INSERT INTO state/);
              rows.set(values[0], values[1]);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

test("cache attachment is optional and must pin a positive version", () => {
  assert.deepEqual(cacheDataSources({}), []);
  assert.deepEqual(cacheDataSources({ KAGGLE_CACHE_DATASET: "" }), []);
  assert.deepEqual(cacheDataSources({ KAGGLE_CACHE_DATASET: "exampleowner/heretic-qwen-cache/2" }), ["exampleowner/heretic-qwen-cache/2"]);
  for (const value of [null, 2, "exampleowner/heretic-qwen-cache", "exampleowner/heretic-qwen-cache/versions/2", "exampleowner/heretic-qwen-cache/0", "exampleowner/heretic-qwen-cache/-1", " exampleowner/heretic-qwen-cache/2", "exampleowner/../2", "https://kaggle.com/datasets/exampleowner/cache/2"]) {
    assert.throws(() => cacheDataSources({ KAGGLE_CACHE_DATASET: value }), (error) => error.status === 500 && error.code === "cache_config");
  }
});

test("both cached and uncached scripts include helpers and compile as Python", () => {
  for (const cacheId of ["", "qwen38-27b-q5kp-test"]) {
    const script = serverScript({ relay: "https://relay.example", token: "unit-test-launch-token", quant: "Q5_K_P", cacheId, contexts: [81920, 65536], vision: true });
    assert.match(script, /def discover_cache\(/);
    assert.match(script, /def main\(/);
    assert.match(script, /def install_async_job_routes\(/);
    assert.ok(script.indexOf("def discover_cache(") < script.indexOf("def main("));
    assert.ok(script.indexOf("def install_async_job_routes(") < script.indexOf("def main("));
    assert.ok(script.includes('"inference_transport": "jobs-v1"'));
    assert.ok(script.includes(`CACHE_ID = ${JSON.stringify(cacheId)}`));
    assert.ok(script.includes("KNOWN_VISION = True"));
    assert.doesNotMatch(script, /__(?:RELAY|LAUNCH_TOKEN|QUANT|CONTEXTS|VISION|CACHE_ID|BATCH_SIZE|PROFILE_ID)__/);
    const compiled = spawnSync(process.env.PYTHON || "python", ["-c", "import sys; compile(sys.stdin.read(), '<kaggle-launch>', 'exec')"], { input: script, encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
  }
});

for (const cached of [false, true]) {
  test(`SaveKernel ${cached ? "attaches the pinned cache" : "retains download fallback without a cache"}`, async (context) => {
    const DB = memoryDb({
      kaggle_fit: { quant: "Q5_K_P", num_ctx: 81920, vision: true, num_batch: 512, profile_id: `${cached ? "qwen38-27b-q5kp-test" : "unversioned"}:Q5_K_P:kv-q8_0:b512:t4x2` },
      preferences: { kaggle_url: "https://www.kaggle.com/code/exampleowner/heretic-qwen-server" },
      "server_log:kaggle": { run_id: "previous-kaggle-run", lines: ["Old Kaggle session"] },
      "server_log:colab": { run_id: "previous-colab-run", lines: ["Old Colab session"] },
    });
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      assert.equal(url, "https://kaggle.invalid/v1/kernels.KernelsApiService/SaveKernel");
      return Response.json({ versionNumber: 7 });
    });
    const env = { DB, KAGGLE_USERNAME: "exampleowner", KAGGLE_API_TOKEN: "test-token", KAGGLE_API_BASE: "https://kaggle.invalid" };
    if (cached) Object.assign(env, { KAGGLE_CACHE_DATASET: "exampleowner/heretic-qwen-cache/2", KAGGLE_CACHE_ID: "qwen38-27b-q5kp-test" });
    const response = await startServer({ env, request: new Request("https://relay.example/v1/server/start", { method: "POST" }) });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    const pushed = calls[0].body;
    assert.deepEqual(pushed.datasetDataSources, cached ? [env.KAGGLE_CACHE_DATASET] : []);
    assert.ok(pushed.text.includes(`CACHE_ID = ${JSON.stringify(cached ? env.KAGGLE_CACHE_ID : "")}`));
    assert.match(pushed.text, /CONTEXTS = \[81920,65536,49152,32768,24576\]/);
    assert.equal(pushed.enableGpu, true);
    assert.equal(pushed.machineShape, "NvidiaTeslaT4");
    assert.equal(pushed.isPrivate, true);
    assert.doesNotMatch(pushed.text, /test-token/);
    const launch = JSON.parse(DB.rows.get("launch"));
    assert.match(launch.token_sha256, /^[0-9a-f]{64}$/);
    assert.equal(launch.version, 7);
    assert.equal(launch.token, undefined);
    assert.equal(DB.rows.has("server_log:kaggle"), false, "a new launch clears the previous Kaggle log");
    assert.equal(JSON.parse(DB.rows.get("server_log:colab")).run_id, "previous-colab-run", "launching Kaggle leaves Colab's log alone");
  });
}

test("bad dataset configuration stops before querying Kaggle or mutating state", async (context) => {
  const DB = memoryDb();
  const fetched = context.mock.method(globalThis, "fetch", () => assert.fail("must not query Kaggle"));
  await assert.rejects(startServer({ env: { DB, KAGGLE_API_TOKEN: "test-token", KAGGLE_CACHE_DATASET: "exampleowner/cache" }, request: new Request("https://relay.example/v1/server/start") }), (error) => error.code === "cache_config");
  assert.equal(fetched.mock.callCount(), 0);
  assert.equal(DB.rows.size, 0);
});

test("the measured profile includes model/runtime identity, cache precision, batch and GPU shape", () => {
  assert.equal(kaggleBatch({}), 512);
  assert.equal(kaggleProfile({ KAGGLE_CACHE_ID: "build-a", KAGGLE_NUM_BATCH: "256" }), "build-a:Q5_K_P:kv-q8_0:b256:t4x2");
  for (const value of [0, 31, 2049, 1.5, "bad"]) assert.throws(() => kaggleBatch({ KAGGLE_NUM_BATCH: value }));
});

test("a legacy or different learned fit cannot suppress larger trials on the new profile", async (context) => {
  for (const fit of [
    { quant: "Q5_K_P", num_ctx: 24576, vision: true },
    { quant: "Q5_K_P", num_ctx: 24576, vision: true, num_batch: 512, profile_id: "older-runtime:Q5_K_P:kv-q8_0:b512:t4x2" },
  ]) {
    const DB = memoryDb({ kaggle_fit: fit });
    const env = { DB, KAGGLE_USERNAME: "exampleowner", KAGGLE_API_TOKEN: "test-token", KAGGLE_API_BASE: "https://kaggle.invalid", KAGGLE_CACHE_ID: "new-build", KAGGLE_NUM_BATCH: "256", KAGGLE_CONTEXT_MAX: "98304" };
    let pushed;
    const fake = context.mock.method(globalThis, "fetch", async (url, options) => { pushed = JSON.parse(options.body); return Response.json({ versionNumber: 8 }); });
    await startServer({ env, request: new Request("https://relay.example/v1/server/start", { method: "POST" }) });
    assert.match(pushed.text, /^CONTEXTS = \[98304,81920,65536,49152,32768,24576\]$/m);
    assert.match(pushed.text, /^KNOWN_VISION = None$/m);
    assert.match(pushed.text, /^BATCH_SIZE = 256$/m);
    assert.ok(pushed.text.includes(`PROFILE_ID = ${JSON.stringify(kaggleProfile(env))}`));
    fake.mock.restore();
  }
});
