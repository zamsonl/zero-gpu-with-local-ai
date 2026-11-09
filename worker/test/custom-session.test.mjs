import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {bootstrapAgentSession} from '../src/agent-sessions.js';
const token='KGAT_fixture_01234567890123456789';
const spec={url:'https://huggingface.co/example/model-GGUF',repo:'example/model-GGUF',revision:'b'.repeat(40),file:'model-Q4_K_M.gguf',sha256:'a'.repeat(64),bytes:5e9,quant:'Q4_K_M',label:'Selected GGUF',context:32768,num_batch:128,profile_id:'hfgguf:'+'a'.repeat(24)};
function fixture(owner='alice'){
  const data=new Map(),saved=[];let lookups=0;
  const db={prepare(sql){return {bind(...args){return {async first(){return data.has(args[0])?{v:data.get(args[0])}:null;},async run(){let changes=1;if(sql.startsWith('INSERT')){if(sql.includes('OR IGNORE')&&data.has(args[0]))changes=0;else data.set(args[0],args[1]);}else if(sql.startsWith('UPDATE')){if(data.get(args[2])===args[3])data.set(args[2],args[0]);else changes=0;}else if(sql.startsWith('DELETE'))data.delete(args[0]);else throw new Error('Unexpected fixture SQL');return {meta:{changes}};}};}};}};
  const env={DB:db,RELAY_KEY:'fixture-relay-secret-0123456789012345',KAGGLE_CACHE_DATASET:'alice/private-cache/2',KAGGLE_CACHE_ID:'fixture-cache'};
  const fetcher=async(url,options)=>{lookups++;if(url.includes('IntrospectToken'))return Response.json({active:true,username:owner});if(url.includes('SaveKernel')){saved.push(JSON.parse(options.body));return Response.json({versionNumber:1});}throw new Error('Unexpected external service: '+url);};
  const start=async(extra={},resolveModel=async()=>spec)=>bootstrapAgentSession({env,fetcher,resolveModel,request:new Request('https://relay.fixture/v1/agent/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kaggle_token:token,consent:true,client_id:'fixture-launch-0123456789',...extra})})});
  return {data,saved,start,lookups:()=>lookups};
}
test('a custom HF model builds one private notebook with its pinned source and no owner cache',async()=>{
  const f=fixture();const response=await f.start({model_url:spec.url});assert.equal(response.status,201,await response.clone().text());const session=await response.json();assert.equal(session.model_profile.context,32768);assert.equal(session.model_profile.source_url,spec.url);assert.equal(session.model_profile.profile_id,spec.profile_id);assert.equal(f.saved.length,1);assert.deepEqual(f.saved[0].datasetDataSources,[]);assert(f.saved[0].text.includes('CUSTOM_MODEL_SPEC = json.loads('));assert(f.saved[0].text.includes(spec.sha256));assert(f.saved[0].text.includes(spec.revision));
  const compiled=spawnSync('python',['-c','import ast,sys;ast.parse(sys.stdin.read())'],{input:f.saved[0].text,encoding:'utf8',windowsHide:true});assert.equal(compiled.status,0,compiled.stderr);assert(!JSON.stringify([...f.data.values()]).includes(token));
  const denied=await f.start({model_url:'https://huggingface.co/example/another-GGUF'});assert.equal(denied.status,409);assert.equal(f.saved.length,1,'a different model cannot reuse the queued allocation identity');
});
test('unsupported providers and failed public metadata never reserve or start a GPU notebook',async()=>{
  const f=fixture();assert.equal((await f.start({model_url:'https://ollama.com/library/qwen'})).status,400);assert.equal(f.lookups(),0);for(const model_url of [false,0,{},null]){assert.equal((await f.start({model_url})).status,400);assert.equal(f.lookups(),0);}
  const failed=await f.start({model_url:spec.url},async()=>{throw Object.assign(new Error('No public GGUF'),{status:400});});assert.equal(f.saved.length,0);assert(![...f.data.keys()].some(k=>k.startsWith('agent:rate:')));assert(failed.status>=400);
});
test('the configured default cache attaches only for its authenticated owner and never changes Qwen profile',async()=>{
  for(const owner of ['alice','bob']){const f=fixture(owner);const response=await f.start();assert.equal(response.status,201,await response.clone().text());assert.deepEqual(f.saved[0].datasetDataSources,owner==='alice'?['alice/private-cache/2']:[]);assert(!f.saved[0].text.includes('CUSTOM_MODEL_SPEC ='));assert(f.saved[0].text.includes('QUANT = "Q5_K_P"'));assert(f.saved[0].text.includes('CONTEXTS = [98304]'));assert(f.saved[0].text.includes('BATCH_SIZE = 256'));}
});
