import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {ownCloudConfig,ownCloudRequest,startPersonalKeepAlive} from '../cloud.mjs';
import {startLocalServer} from '../server.mjs';

import {RELAY_ORIGIN as SERVICE} from '../deployment.mjs';
const SESSION='personal_session_0123456789';
const KEY='dummy-personal-helper-secret-01234567890123456789';
const config=()=>({session_id:SESSION,relay:SERVICE+'/_agent/'+SESSION,key:KEY,host:'kaggle',owner:'dummyvisitor',expires_at:'2099-01-01T00:00:00.000Z',url:'https://www.kaggle.com/code/dummyvisitor/qwen-agent-owned'});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const workspace=()=>({root:'owned-synthetic-project',listPage:async()=>({entries:[],truncated:false}),read:async()=>({path:'file.txt',content:'synthetic',hash:'dummy'})});
const headers=local=>({authorization:'Bearer '+local.token,'content-type':'application/json'});
const post=(local,path,body={})=>fetch(local.origin+'/api/'+path,{method:'POST',headers:headers(local),body:JSON.stringify(body)});
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await delay(5);}throw new Error('Expected synthetic state did not arrive.');}

test('personal cloud operations reject global owner routes and mismatched sessions before fetch',async()=>{
  let calls=0;const fetcher=async()=>{calls++;return json({server:'ready'});};
  assert.equal(ownCloudConfig({relay:SERVICE,key:'dummy-owner-key'}),null);
  for(const bad of [
    {...config(),relay:SERVICE},
    {...config(),relay:SERVICE+'/_agent/another_personal_session'},
    {...config(),relay:'https://elsewhere.invalid/_agent/'+SESSION},
    {...config(),relay:SERVICE+'/_agent/'+SESSION+'?redirect=owner'},
    {...config(),session_id:'../owner'},
    {...config(),host:'colab'},
    {...config(),key:'short'},
  ])await assert.rejects(ownCloudRequest(bad,'/v1/status',{fetcher}));
  await assert.rejects(ownCloudRequest({relay:SERVICE,key:'dummy-owner-key'},'/v1/server/shutdown',{fetcher}));
  await assert.rejects(ownCloudRequest(config(),'/v1/server/start',{fetcher}));
  assert.equal(calls,0);
});

test('personal status and shutdown forward only the scoped helper credential',async()=>{
  const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});return json({ok:true,server:'ready'});};
  await ownCloudRequest(config(),'/v1/status',{fetcher});
  await ownCloudRequest(config(),'/v1/server/shutdown',{fetcher});
  assert.deepEqual(calls.map(c=>[c.url,c.options.method]),[
    [SERVICE+'/_agent/'+SESSION+'/v1/status','GET'],
    [SERVICE+'/_agent/'+SESSION+'/v1/server/shutdown','POST'],
  ]);
  assert(calls.every(c=>c.options.headers['x-relay-key']===KEY));
  assert(calls.every(c=>c.options.redirect==='error'));
  assert.equal(calls[0].options.body,undefined);assert.equal(calls[1].options.body,'{}');
  assert(!JSON.stringify(calls).includes('kaggle_token'));
});

test('personal heartbeat forwards only its scoped temporary credential and never a Kaggle token',async()=>{
  let called;await ownCloudRequest(config(),'/v1/heartbeat',{fetcher:async(url,options)=>{called={url,options};return json({ok:true});}});
  assert.equal(called.url,config().relay+'/v1/heartbeat');assert.equal(called.options.method,'POST');assert.equal(called.options.body,'{}');assert.equal(called.options.headers['x-relay-key'],KEY);
  assert(!JSON.stringify(called).includes('kaggle_token'));assert.equal(called.options.redirect,'error');
});

function heartbeatFixture(request){
  const timers=[],cleared=[];let errors=0;
  const loop=startPersonalKeepAlive(config(),{request,setTimer:(callback,ms)=>{const timer={callback,ms,unref(){this.unreferenced=true;}};timers.push(timer);return timer;},clearTimer:timer=>cleared.push(timer),onError:(...args)=>{assert.equal(args.length,0);errors++;}});
  return {loop,timers,cleared,get errors(){return errors;}};
}
test('the open local window renews a nonoverlapping personal lease and close cancels its timer',async()=>{
  const calls=[];const f=heartbeatFixture(async(...args)=>{calls.push(args);return {ok:true};});assert.equal(await f.loop.ready,true);
  assert.equal(calls.length,1);assert.equal(calls[0][1],'/v1/heartbeat');assert.equal(calls[0][0].relay,config().relay);assert(calls[0][2].signal instanceof AbortSignal);
  assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,30000);assert(f.timers[0].unreferenced);
  f.timers[0].callback();await delay(0);assert.equal(calls.length,2);assert.equal(f.timers.length,2);
  f.loop.stop();assert(calls[0][2].signal.aborted);assert(f.cleared.includes(f.timers[1]));f.timers[1].callback();await delay(0);assert.equal(calls.length,2);
});
test('heartbeat waits for an in-flight acknowledgement rather than accumulating overlapping requests',async()=>{
  const pending=deferred();let calls=0;const f=heartbeatFixture(async()=>{calls++;return pending.promise;});
  assert.equal(calls,1);assert.equal(f.timers.length,0);pending.resolve({ok:true});assert.equal(await f.loop.ready,true);assert.equal(f.timers.length,1);f.loop.stop();
});
test('transient heartbeat failures retry but an expired or shut-down personal session stops the lease',async()=>{
  const transient=heartbeatFixture(async()=>{throw Error('remote secret must not be exposed');});assert.equal(await transient.loop.ready,false);assert.equal(transient.errors,1);assert.equal(transient.timers.length,1);transient.loop.stop();
  for(const status of [401,403,409,410]){
    const f=heartbeatFixture(async()=>{throw Object.assign(Error('private'),{status});});assert.equal(await f.loop.ready,false);assert.equal(f.errors,1);assert.equal(f.timers.length,0);
  }
});
test('an already cancelled local window cannot start a heartbeat or target an owner connection',async()=>{
  let calls=0;const abort=new AbortController();abort.abort();const loop=startPersonalKeepAlive(config(),{signal:abort.signal,request:async()=>calls++});assert.equal(await loop.ready,false);assert.equal(calls,0);
  assert.throws(()=>startPersonalKeepAlive({relay:SERVICE,key:KEY}),/personal Kaggle/);
});

test('server rejects tasks while the personal Kaggle notebook is still loading',async t=>{
  let inferences=0;const calls=[];
  const local=await startLocalServer({workspace:workspace(),config:config(),infer:async()=>{inferences++;return {action:'answer',message:'Done'};},cloudFetch:async url=>{calls.push(url);return json({server:'unregistered',boot:{detail:'Loading your own model'}});}});
  t.after(()=>local.close());
  const response=await post(local,'task',{task:'Should wait for my own notebook'});
  assert.equal(response.status,400);assert.match((await response.json()).error,/not ready/);
  assert.equal(inferences,0);assert(calls.every(url=>url.startsWith(SERVICE+'/_agent/'+SESSION+'/')));
});

test('local browser state exposes account/status without either API credential',async t=>{
  const cfg={...config(),kaggle_token:'dummy-kaggle-token-must-not-leak'};
  const local=await startLocalServer({workspace:workspace(),config:cfg,infer:async()=>({action:'answer',message:'Done'}),cloudFetch:async()=>json({server:'ready'})});
  t.after(()=>local.close());
  await fetch(local.origin+'/api/cloud/status',{headers:headers(local)});
  const response=await fetch(local.origin+'/api/state',{headers:headers(local)});const text=await response.text();const state=JSON.parse(text);
  assert.equal(state.cloud.owner,'dummyvisitor');assert.equal(state.cloud.host,'kaggle');
  assert(!text.includes(KEY));assert(!text.includes(cfg.kaggle_token));assert(!text.includes('x-relay-key'));
});

test('a stale readiness poll cannot reverse personal shutdown or allow a new inference',async t=>{
  const statusStarted=deferred(),oldStatus=deferred();let inferences=0;const calls=[];
  const local=await startLocalServer({workspace:workspace(),config:config(),infer:async()=>{inferences++;return {action:'answer',message:'Done'};},cloudFetch:async(url,options)=>{
    calls.push({url,method:options.method});
    if(url.endsWith('/shutdown'))return json({ok:true,shutdown:'requested'});
    if(calls.filter(c=>c.url.endsWith('/status')).length===1){statusStarted.resolve();return oldStatus.promise;}
    return json({server:'ready',shutting_down:false});
  }});
  t.after(async()=>{oldStatus.resolve(json({server:'ready',shutting_down:false}));await local.close();});
  await fetch(local.origin+'/api/state',{headers:headers(local)});await statusStarted.promise;
  assert.equal((await post(local,'cloud/shutdown')).status,200);
  oldStatus.resolve(json({server:'ready',shutting_down:false}));await delay(10);
  const state=await(await fetch(local.origin+'/api/state',{headers:headers(local)})).json();
  assert.equal(state.cloud.shutting_down,true);
  const task=await post(local,'task',{task:'Must not restart during shutdown'});assert.notEqual(task.status,202);assert.equal(inferences,0);
  const shutdowns=calls.filter(c=>c.url.endsWith('/shutdown'));assert.equal(shutdowns.length,1);assert.equal(shutdowns[0].url,SERVICE+'/_agent/'+SESSION+'/v1/server/shutdown');
});

test('Stop during readiness preflight cannot launch an inference afterward',async t=>{
  const checking=deferred(),ready=deferred();let inferences=0;
  const local=await startLocalServer({workspace:workspace(),config:config(),infer:async()=>{inferences++;return {action:'answer',message:'Done'};},cloudFetch:async()=>{checking.resolve();return ready.promise;}});
  t.after(async()=>{ready.resolve(json({server:'ready'}));await local.close();});
  const task=post(local,'task',{task:'Cancel while checking readiness'});await checking.promise;
  assert.equal((await post(local,'stop')).status,200);ready.resolve(json({server:'ready'}));
  assert.notEqual((await task).status,202);assert.equal(inferences,0);
});

test('a ready personal notebook can run a task without touching an owner endpoint',async t=>{
  let inferences=0;const calls=[];
  const local=await startLocalServer({workspace:workspace(),config:config(),infer:async()=>{inferences++;return {action:'answer',message:'Personal synthetic result'};},cloudFetch:async url=>{calls.push(url);return json({server:'ready'});}});
  t.after(()=>local.close());
  assert.equal((await post(local,'task',{task:'A scoped task'})).status,202);await until(()=>!local.engine.busy);
  assert.equal(inferences,1);assert.equal(local.engine.phase,'Task finished');assert(calls.every(url=>url.startsWith(SERVICE+'/_agent/'+SESSION+'/')));
});
test('an unconfirmed shutdown can be retried while inference remains blocked',async t=>{
  let attempts=0,inferences=0;
  const local=await startLocalServer({workspace:workspace(),config:config(),infer:async()=>{inferences++;return {action:'answer',message:'Unexpected'};},cloudFetch:async url=>{
    if(url.endsWith('/shutdown')){attempts++;if(attempts===1)throw new Error('Synthetic dropped acknowledgment');return json({ok:true});}
    return json({server:'ready',shutting_down:false});
  }});t.after(()=>local.close());
  assert.equal((await post(local,'cloud/shutdown')).status,400);
  const state=await(await fetch(local.origin+'/api/state',{headers:headers(local)})).json();
  assert.equal(state.cloud.shutting_down,true);assert.equal(state.cloud.shutdown_acknowledged,false);assert(state.cloud.shutdown_error);
  assert.notEqual((await post(local,'task',{task:'Must remain blocked'})).status,202);
  assert.equal((await post(local,'cloud/shutdown')).status,200);assert.equal(attempts,2);assert.equal(inferences,0);
});
