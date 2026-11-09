import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareOwnCache} from '../cache.mjs';
import {RELAY_ORIGIN} from '../kaggle-session.mjs';

const TOKEN='KGAT_fixture_personal_cache_0123456789',ID='agent-cache-v1-'+'a'.repeat(32);
const state=(status,extra={})=>({state:status,owner:'alice',cache_id:ID,model_url:null,detail:status==='ready'?'Private cache ready.':'CPU cache preparation; no GPU allocated.',notebook_url:'https://www.kaggle.com/code/alice/heretic-qwen-agent-cache-build',...(status==='ready'?{dataset:'alice/heretic-agent-'+'a'.repeat(32)+'/1'}:{}),...extra});

test('cache preparation requires personal consent and a supported model before networking',async()=>{
  let calls=0;const fetcher=async()=>{calls++;assert.fail();};
  await assert.rejects(prepareOwnCache({token:TOKEN,consent:false,fetcher}));
  await assert.rejects(prepareOwnCache({token:TOKEN,consent:true,modelUrl:'https://evil.invalid/model.gguf',fetcher}));assert.equal(calls,0);
});

test('first preparation polls one cache identity and never calls a GPU launch endpoint',async()=>{
  const calls=[],progress=[],statuses=['queued','building','processing','ready'];
  const result=await prepareOwnCache({token:TOKEN,consent:true,pause:async()=>{},onProgress:event=>progress.push(event),fetcher:async(url,options)=>{assert.equal(url,RELAY_ORIGIN+'/v1/agent/cache');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');const body=JSON.parse(options.body);calls.push(body);return Response.json(state(statuses.shift()));}});
  assert.equal(result.cache_id,ID);assert.equal(calls.length,4);assert.equal(calls[0].retry,true);assert(calls.slice(1).every(call=>call.cache_id===ID&&!call.retry));assert.equal(progress.at(-1).state,'complete');assert(!JSON.stringify(progress).includes(TOKEN));
});

test('ready cache returns immediately; another account or model cannot be silently accepted',async()=>{
  let calls=0;await prepareOwnCache({token:TOKEN,consent:true,fetcher:async()=>{calls++;return Response.json(state('ready'));}});assert.equal(calls,1);
  const requests=[];await assert.rejects(prepareOwnCache({token:TOKEN,consent:true,pause:async()=>{},fetcher:async(url,options)=>{requests.push(JSON.parse(options.body));return Response.json(state('ready',{dataset:'bob/foreign/1'}));}}),/invalid pinned/);assert.equal(requests.at(-1).action,'cancel');
  await assert.rejects(prepareOwnCache({token:TOKEN,consent:true,modelUrl:'https://huggingface.co/example/model',fetcher:async()=>Response.json(state('ready'))}),/selected model/);
});

test('cancelling during a CPU build sends its scoped account cancellation and starts no GPU',async()=>{
  const cancellation=new AbortController(),calls=[];
  await assert.rejects(prepareOwnCache({token:TOKEN,consent:true,signal:cancellation.signal,pause:async()=>{cancellation.abort();},fetcher:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return Response.json(state(body.action==='cancel'?'cancelled':'queued'));}}),error=>error.name==='AbortError');
  assert.equal(calls.length,2);assert.equal(calls[1].action,'cancel');assert.equal(calls[1].cache_id,ID);
});

test('lost first acknowledgement cancels by account/model even before a cache id was received',async()=>{
  const cancellation=new AbortController(),calls=[];
  await assert.rejects(prepareOwnCache({token:TOKEN,consent:true,signal:cancellation.signal,fetcher:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);if(!body.action){cancellation.abort();throw new Error('Lost connection');}return Response.json(state('cancelled'));}}),error=>error.name==='AbortError');
  assert.equal(calls.at(-1).action,'cancel');assert.equal(calls.at(-1).cache_id,undefined);
});

test('cache failure is explicit and does not retry a complete failed build automatically',async()=>{
  let calls=0;await assert.rejects(prepareOwnCache({token:TOKEN,consent:true,fetcher:async()=>{calls++;return Response.json(state('failed',{detail:'Dataset storage unavailable.'}));}}),/Dataset storage/);assert.equal(calls,1);
});
