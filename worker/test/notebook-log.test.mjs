import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { appendLog, cleanLogLine, logBatch, LOG_MAX_CHARS, LOG_MAX_LINES } from "../src/notebook-log.js";
import { startStack, RELAY_KEY } from "./dev-stack.mjs";

const started = "2026-10-01T00:00:00.000Z";
const batch = (extra = {}) => logBatch({ host: "colab", run_id: "colab-run-0001", started_at: started, seq: 0, lines: ["runtime cache hit"], ...extra });

test("operational log strips terminal controls, tunnel URLs, credentials and exact scoped secrets", () => {
  const cleaned = cleanLogLine('\x1b[31mREADY https://private-name.trycloudflare.com\x1b[0m x-launch-token: secret-token KGAT_abcd1234 Bearer oauth-token envkey-123\n', ["secret-token", "envkey-123"]);
  assert.match(cleaned, /READY \[tunnel address hidden\]/);
  for (const secret of ["secret-token", "KGAT_abcd1234", "oauth-token", "envkey-123", "\x1b", "\n"]) assert(!cleaned.includes(secret), secret);
});

test("log batches reject malformed, excessive and future-dated inputs", () => {
  for (const change of [{host:"other"},{run_id:"bad/id"},{seq:-1},{seq:1.1},{lines:[2]},{lines:Array(41).fill("x")},{lines:["x".repeat(2001)]},{status:"READY"},{started_at:"not a date"},{started_at:new Date(Date.now()+3600000).toISOString()}]) {
    assert.throws(() => batch(change), {status:400}, JSON.stringify(change).slice(0,80));
  }
});

test("batch retries deduplicate and old runs cannot replace a newer run", () => {
  const first = appendLog(null,batch());
  assert.equal(appendLog(first,batch()),first);
  const next = appendLog(first,batch({seq:1,lines:["model loaded"]}));
  assert.deepEqual(next.lines,["runtime cache hit","model loaded"]);
  assert.equal(appendLog(next,batch()),next);
  const newer = appendLog(next,batch({run_id:"colab-run-0002",started_at:"2026-10-02T00:00:00Z",lines:["new run"]}));
  assert.deepEqual(newer.lines,["new run"]);
  assert.throws(()=>appendLog(newer,batch({seq:2})),{status:409});
  assert.throws(()=>appendLog(null,batch({seq:1})),{status:409});
  assert.throws(()=>appendLog(next,batch({seq:2,started_at:"2026-10-01T01:00:00Z"})),{status:409});
});

test("the rolling tail is bounded by line count and total characters", () => {
  let state=null;
  for(let seq=0;seq<14;seq++) state=appendLog(state,batch({seq,lines:Array.from({length:40},(_,i)=>`${seq}-${i}`)}));
  assert.equal(state.lines.length,LOG_MAX_LINES);assert.equal(state.truncated,true);assert.equal(state.lines.at(-1),"13-39");
  state=null;
  for(let seq=0;seq<10;seq++) state=appendLog(state,batch({seq,lines:Array(40).fill("x".repeat(2000))}));
  assert(state.lines.reduce((n,line)=>n+line.length+1,0)<=LOG_MAX_CHARS);assert.equal(state.truncated,true);
});

test("late RUNNING batches cannot reopen a terminal run", () => {
  const ended=appendLog(null,batch({status:"ERROR"}));
  const late=appendLog(ended,batch({seq:1,status:"RUNNING",lines:["late buffered line"]}));
  assert.equal(late.status,"ERROR");assert.equal(late.lines.at(-1),"late buffered line");
});

let stack;
before(async()=>{stack=await startStack({port:8828,mockPort:11528,state:".test-state/notebook-logs",vars:{KAGGLE_CACHE_DATASET:"",KAGGLE_CACHE_ID:""}});});
after(async()=>{await stack?.stop();});
async function call(method,path,body,headers={}) {
  const response=await fetch(stack.url+path,{method,headers:{"content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let parsed=null;try{parsed=JSON.parse(text)}catch{}
  return {status:response.status,body:parsed,text};
}
const withKey={"x-relay-key":RELAY_KEY};
const fields=(extra={})=>({host:"colab",run_id:"colab-integration-0001",started_at:new Date().toISOString(),seq:0,lines:["Preparing runtime"],...extra});

test("Colab logs need notebook authentication but no Kaggle API token; default legacy host is Colab",async()=>{
  await stack.sql("DELETE FROM state WHERE k LIKE 'server_log:%' OR k IN ('boot','launch')");
  const empty=await call("GET","/v1/server/log?host=colab");assert.equal(empty.status,200);assert.equal(empty.body.source,"unavailable");assert.equal(empty.body.host,"colab");assert.match(empty.body.message,/updated startup cell/);
  assert.equal((await call("GET","/v1/server/log")).body.host,"colab");
  const first=fields();
  assert.equal((await call("POST","/_relay/log",first)).status,401);
  assert.equal((await call("POST","/_relay/log",first,withKey)).status,200);
  assert.equal((await call("POST","/_relay/log",first,withKey)).body.duplicate,true);
  const read=await call("GET","/v1/server/log?host=colab");assert.equal(read.body.source,"reported");assert.equal(read.body.log,"Preparing runtime");assert.equal(read.body.run_id,first.run_id);
  assert.equal((await call("GET","/v1/server/log?host=other")).status,400);
  const newer=fields({run_id:"colab-integration-0002",started_at:new Date(Date.parse(first.started_at)+1000).toISOString(),lines:["New Colab session"]});
  assert.equal((await call("POST","/_relay/log",newer,withKey)).status,200);
  assert.equal((await call("POST","/_relay/log",{...first,seq:1},withKey)).status,409);
  assert.equal((await call("GET","/v1/server/log?host=colab")).body.log,"New Colab session");
});

test("a valid scoped launch token can report sanitized Kaggle logs but cannot access raw model routes",async()=>{
  const token="scoped-test-launch-token",at=new Date().toISOString();
  const launch={token_sha256:createHash("sha256").update(token).digest("hex"),at,expires_at:new Date(Date.now()+3600000).toISOString(),user:"tester",slug:"heretic-qwen-server"};
  await stack.sql(`INSERT INTO state(k,v,updated_at) VALUES('launch','${JSON.stringify(launch)}','${at}') ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`);
  const headers={"x-launch-token":token};
  const posted=fields({host:"kaggle",run_id:"kaggle-integration-001",started_at:at,lines:[`runtime ready ${token} ${RELAY_KEY} https://secret-tunnel.trycloudflare.com`]});
  assert.equal((await call("POST","/_relay/log",posted,headers)).status,200);
  assert.equal((await call("POST","/_relay/log",{...posted,host:"colab"},headers)).status,403);
  const got=(await call("GET","/v1/server/log?host=kaggle")).body;
  assert.equal(got.host,"kaggle");assert.equal(got.source,"reported");assert(got.log.includes("runtime ready"));assert(!got.log.includes(token));assert(!got.log.includes(RELAY_KEY));assert(!got.log.includes("secret-tunnel"));
  assert.equal((await call("GET","/api/tags",undefined,headers)).status,401);
  assert.equal((await call("POST","/_relay/log",{...posted,seq:1},{"x-launch-token":token+"wrong"})).status,401);
  assert.equal((await call("GET","/v1/server/log?host=colab")).body.log,"New Colab session","host tails do not mix");
});
