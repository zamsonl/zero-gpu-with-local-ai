import assert from 'node:assert/strict';
import {test} from 'node:test';
import {preparePersonalCache,personalCacheCallback,readyPersonalCache} from '../src/personal-cache.js';
import {createPersonalCacheSpec,personalCacheBuilderScript} from '../src/personal-cache-source.js';
import {serverScript} from '../src/kaggle.js';
import {spawnSync} from 'node:child_process';

const token=owner=>'KGAT_fixture_'+owner+'_012345678901234567890';
const request=body=>new Request('https://relay.example.invalid/v1/agent/cache',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
function database(){const values=new Map();return {values,prepare(sql){return {bind(...args){return {first:async()=>values.has(args[0])?{v:values.get(args[0])}:null,run:async()=>{let changes=0;if(sql.startsWith('INSERT')){if(!values.has(args[0])){values.set(args[0],args[1]);changes=1;}}else if(sql.startsWith('UPDATE')&&values.get(args[2])===args[3]){values.set(args[2],args[0]);changes=1;}return {meta:{changes}};}};}};}};}
function fixture(){
  const db=database(),pushes=[],creates=[],datasets=new Map();let loseSave=false,loseCreate=false,refuseCreate=false;
  const env={DB:db,RELAY_KEY:'fixture_signing_key_that_is_not_real'},send=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const fetcher=async(url,options)=>{
    const body=JSON.parse(options.body),method=url.split('/').at(-1),owner=options.headers.authorization.includes('alice')?'alice':options.headers.authorization.includes('bob')?'bob':'owner';
    if(method==='IntrospectToken')return send({active:true,username:owner});
    if(method==='SaveKernel'){pushes.push(body);if(loseSave)throw new Error('Lost acknowledgement');return send({versionNumber:1});}
    if(method==='GetKernelSessionStatus')return send({status:'COMPLETE'});
    const handle=body.ownerSlug+'/'+(body.datasetSlug||body.slug);
    if(method==='GetDataset')return datasets.has(handle)?send(datasets.get(handle)):send({},404);
    if(method==='CreateDataset'){creates.push(body);if(refuseCreate)return send({},403);datasets.set(handle,{ref:handle,isPrivate:body.isPrivate,currentVersionNumber:1,description:body.description});if(loseCreate)throw new Error('Lost commit acknowledgement');return send({id:1});}
    if(method==='GetDatasetStatus')return datasets.has(handle)?send({status:'READY'}):send({},404);
    assert.fail('Unexpected Kaggle method '+method);
  };
  const prepare=async(owner='alice',extra={})=>{const response=await preparePersonalCache({request:request({consent:true,kaggle_token:token(owner),...extra}),env,fetcher});return {response,value:await response.json()};};
  const recordFor=owner=>[...db.values.values()].map(raw=>JSON.parse(raw)).find(v=>v.owner===owner&&v.build_id);
  const controlFor=owner=>JSON.parse(JSON.parse(/^PERSONAL_CACHE_CONTROL = json.loads\((.*)\)$/m.exec(pushes.find(p=>p.slug.startsWith(owner+'/')).text)[1]));
  const report=async(owner='alice',extra={})=>{const control=controlFor(owner),record=recordFor(owner);const response=await personalCacheCallback({request:new Request(control.relay+'/report',{method:'POST',headers:{'x-cache-token':control.token,'content-type':'application/json'},body:JSON.stringify({state:'uploaded',phase:'uploaded',detail:'Files verified',cache_id:record.cache_id,build_id:record.build_id,manifest_sha256:'a'.repeat(64),upload:{files:[{token:'fixture_upload_capability_123'}],directories:[]},...extra})}),env,id:record.id});return {response,value:await response.json()};};
  return {env,db,pushes,creates,datasets,prepare,recordFor,controlFor,report,set loseSave(value){loseSave=value;},set loseCreate(value){loseCreate=value;},set refuseCreate(value){refuseCreate=value;}};
}

test('first setup uses one private CPU builder and later launches reuse a pinned owned Dataset',async()=>{
  const f=fixture(),first=await f.prepare();assert.equal(first.response.status,200);assert.equal(first.value.state,'queued');assert.equal(f.pushes.length,1);
  const pushed=f.pushes[0];assert.equal(pushed.enableGpu,false);assert.equal(pushed.isPrivate,true);assert.match(pushed.slug,/^alice\/heretic-agent-cache-build-[a-f0-9]{12}$/);assert(!pushed.text.includes(token('alice')));
  assert.equal((await f.report()).response.status,200);assert(!JSON.stringify([...f.db.values.values()]).includes('fixture_upload_capability_123'));const ready=await f.prepare('alice',{cache_id:first.value.cache_id});assert.equal(ready.value.state,'ready');assert.match(ready.value.dataset,/^alice\/heretic-agent-[a-f0-9]{32}\/1$/);
  assert.equal(f.creates.length,1);assert.equal(f.creates[0].isPrivate,true);assert.equal(f.creates[0].ownerSlug,'alice');assert(!JSON.stringify(ready.value).includes('fixture_upload_capability'));
  await f.prepare();assert.equal(f.pushes.length,1);assert.equal(f.creates.length,1);assert(!JSON.stringify([...f.db.values.values()]).includes(token('alice')));
  const launch=await readyPersonalCache({env:f.env,owner:'alice',cacheId:first.value.cache_id});assert.equal(launch.dataset,ready.value.dataset);assert.equal(launch.spec.manifest_sha256,'a'.repeat(64));
});

test('reinstall or a new relay database reuses an owned ready Dataset without another builder',async()=>{
  const f=fixture();await f.prepare();await f.report();const first=await f.prepare();assert.equal(first.value.state,'ready');
  f.db.values.clear();const reused=await f.prepare();assert.equal(reused.value.state,'ready');assert.equal(reused.value.dataset,first.value.dataset);assert.equal(f.pushes.length,1);assert.equal(f.creates.length,1);
});

test('concurrent initial setup and commit are idempotent; accounts remain isolated',async()=>{
  const f=fixture();await Promise.all([f.prepare(),f.prepare(),f.prepare()]);assert.equal(f.pushes.length,1);
  await f.prepare('bob');assert.equal(f.pushes.length,2);assert.notEqual(f.recordFor('alice').id,f.recordFor('bob').id);
  await f.report();await Promise.all([f.prepare(),f.prepare(),f.prepare()]);assert.equal(f.creates.length,1);
  await assert.rejects(readyPersonalCache({env:f.env,owner:'bob',cacheId:f.recordFor('alice').cache_id}),error=>error.code==='personal_cache_not_ready');
});

test('lost CPU and Dataset acknowledgements never submit duplicate jobs or versions',async()=>{
  const f=fixture();f.loseSave=true;const first=await f.prepare();assert.equal(first.value.state,'unknown');await f.prepare();assert.equal(f.pushes.length,1);
  await f.report();f.loseCreate=true;const result=await f.prepare();assert.equal(result.value.state,'ready');await f.prepare();assert.equal(f.creates.length,1);assert.equal(f.pushes.length,1);
});

test('unrelated/public datasets and storage permission failures cannot become ready or trigger a GPU',async()=>{
  const f=fixture();await f.prepare();await f.report();const record=f.recordFor('alice');f.datasets.set('alice/'+record.slug,{ref:'alice/'+record.slug,isPrivate:false,currentVersionNumber:1,description:'Private coding-agent cache: '+record.cache_id});
  const rejected=await f.prepare();assert.equal(rejected.response.status,409);assert.equal(rejected.value.error.code,'cache_identity_mismatch');assert.equal(f.creates.length,0);
  const g=fixture();await g.prepare();await g.report();g.refuseCreate=true;const denied=await g.prepare();assert.equal(denied.value.state,'failed');assert.equal(g.creates.length,1);assert(g.pushes.every(p=>p.enableGpu===false));
});

test('callbacks are generation/account scoped, cannot move backwards, and cancel before GPU launch',async()=>{
  const f=fixture();const first=await f.prepare();await f.prepare('bob');const control=f.controlFor('bob'),alice=f.recordFor('alice');
  const foreign=await personalCacheCallback({request:new Request('https://relay.example.invalid/_agent-cache/'+alice.id+'/command',{headers:{'x-cache-token':control.token}}),env:f.env,id:alice.id});assert.equal(foreign.status,401);
  const cancel=await f.prepare('alice',{cache_id:first.value.cache_id,action:'cancel'});assert.match(cancel.value.detail,/Cancellation/);
  await f.report();assert.equal(f.creates.length,0);assert.equal(f.recordFor('alice').upload,undefined);
  const own=f.controlFor('alice'),command=await personalCacheCallback({request:new Request(own.relay+'/command',{headers:{'x-cache-token':own.token}}),env:f.env,id:alice.id});assert.equal((await command.json()).cancel,true);
  await f.report('alice',{state:'cancelled'});assert.equal((await f.prepare()).value.state,'cancelled');
});

test('unsafe upload directories and missing manifest verification are refused',async()=>{
  const f=fixture();await f.prepare();assert.equal((await f.report('alice',{upload:{files:[],directories:[{name:'..',files:[{token:'fixture_capability'}],directories:[]}]}})).response.status,400);
  assert.equal((await f.report('alice',{manifest_sha256:'wrong'})).response.status,400);assert.equal(f.creates.length,0);
});

test('configured legacy owner cache stays fast and is never inherited by another account',async()=>{
  const f=fixture();Object.assign(f.env,{KAGGLE_CACHE_DATASET:'alice/existing-private-cache/2',KAGGLE_CACHE_ID:'legacy-cache-fixture'});
  const ready=await f.prepare();assert.equal(ready.value.state,'ready');assert.equal(f.pushes.length,0);assert.equal(ready.value.dataset,'alice/existing-private-cache/2');
  await f.prepare('bob');assert.equal(f.pushes.length,1);assert(f.pushes[0].slug.startsWith('bob/'));
});

test('default and custom builder/runtime scripts compile and preserve custom validation after a cache hit',async()=>{
  const model={url:'https://huggingface.co/fixture/model/blob/main/chat.gguf',repo:'fixture/model',revision:'b'.repeat(40),file:'chat.gguf',sha256:'c'.repeat(64),bytes:100*1024**2,quant:'Q4_K_M',context:32768,profile_id:'hfgguf:'+ 'a'.repeat(24),label:'Fixture model'};
  for(const selected of [null,model]){
    const spec=await createPersonalCacheSpec(selected),builder=personalCacheBuilderScript(spec,{owner:'fixture',relay:'https://relay.example.invalid/_agent-cache/'+'a'.repeat(40),token:'b'.repeat(64),buildId:'c'.repeat(32)});
    const runtime=serverScript({relay:'https://relay.example.invalid/_agent/'+'d'.repeat(40),token:'e'.repeat(64),quant:selected?.quant||'Q5_K_P',contexts:selected?[32768,24576,16384,8192]:[98304],agentOnly:true,modelSpec:selected,personalCacheSpec:{...spec,manifest_sha256:'f'.repeat(64)}});
    for(const source of [builder,runtime]){const result=spawnSync('python',['-c','import sys; compile(sys.stdin.read(), "generated.py", "exec")'],{input:source,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
    assert(builder.includes('enable')||builder.includes('used_gpu'));assert(!builder.includes(token('alice')));
    if(selected){assert(runtime.includes('Checking the downloaded GGUF checksum'));assert(runtime.includes("cached_model = cache['manifest'].get('schema') != 2"));}
  }
});
