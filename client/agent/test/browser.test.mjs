import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalBrowser,browserUrl} from '../browser.mjs';
import {AgentEngine,actionValue} from '../engine.mjs';

const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Expected state did not arrive.');};
function fakeBrowser(){
  const state={url:'about:blank',text:'Synthetic page',launches:0,clicks:0,fills:[],closed:0,contextOptions:null,navigation:[],elements:[{tag:'button',type:'button',role:'button',name:'',id:'test',autocomplete:'',label:'Run check',href:'',disabled:false,value:'',fields:[],oversized:false}]};
  const handles=[];
  const page={url:()=>state.url,isClosed:()=>state.closed>0,setDefaultTimeout(){},setDefaultNavigationTimeout(){},on(){},title:async()=>'Synthetic browser fixture',evaluate:async()=>state.text.slice(0,24001),
    goto:async url=>{state.navigation.push(url);state.url=url;},screenshot:async()=>Buffer.from('synthetic-png'),
    locator:()=>({count:async()=>state.elements.length,nth:index=>({elementHandle:async()=>{const handle={disposed:false,isVisible:async()=>true,evaluate:async()=>structuredClone(state.elements[index]),click:async()=>{state.clicks++;},fill:async text=>{state.fills.push(text);state.elements[index].value=text;},dispose:async()=>{handle.disposed=true;}};handles.push(handle);return handle;}})})};
  const context={newPage:async()=>page,on(){},route:async(pattern,handler)=>{state.routePattern=pattern;state.routeHandler=handler;},close:async()=>{state.closed++;}};
  const browser={newContext:async options=>{state.contextOptions=options;return context;},close:async()=>{state.closed++;state.onClose?.();}};
  const loadPlaywright=async()=>({chromium:{launch:async options=>{state.launches++;state.launchOptions=options;return browser;}}});
  return {state,page,browser,handles,loadPlaywright};
}
async function opened(t,options={}){const fake=fakeBrowser();const tool=new LocalBrowser({loadPlaywright:fake.loadPlaywright,...options});t.after(()=>tool.close());const prepared=await tool.prepare({action:'browser_open',path:'http://127.0.0.1:4321/fixture'});const snapshot=await tool.execute(prepared);return {...fake,tool,snapshot};}

test('browser navigation rejects system files, embedded credentials and helper control origins',()=>{
  for(const url of ['file:///C:/secret.txt','data:text/html,x','javascript:alert(1)','https://user:password@example.test/','https://example.test/?api_key=secret',...['key','session','session_id','auth','code','csrf'].map(key=>'https://example.test/?'+key+'=secret')])assert.throws(()=>browserUrl(url));
  assert.throws(()=>browserUrl('http://127.0.0.1:1234/api/state',['http://127.0.0.1:1234']));
  assert.equal(browserUrl('http://localhost:3000/test?query=hello'),'http://localhost:3000/test?query=hello');
});
test('no browser is launched by a proposal, pre-navigation read, or rejected navigation',async()=>{
  const fake=fakeBrowser();const tool=new LocalBrowser({loadPlaywright:fake.loadPlaywright});
  await tool.prepare({action:'browser_open',path:'https://example.test/'});await assert.rejects(tool.snapshot(),/No isolated browser/);assert.equal(fake.state.launches,0);
  const actions=[{action:'browser_open',path:'https://example.test/',message:'Open test page'},{action:'answer',message:'Cancelled'}];
  const engine=new AgentEngine({root:'owned'},async()=>actions.shift(),{browser:tool});const work=engine.start('Inspect test page');await until(()=>engine.pending);engine.decide(engine.pending.id,false);await work;assert.equal(fake.state.launches,0);await tool.close();
});
test('isolated launch never attaches to an existing profile and disables downloads/permissions',async t=>{
  const {state,snapshot}=await opened(t);assert.equal(state.launches,1);assert.equal(state.launchOptions.headless,false);assert.equal(state.launchOptions.userDataDir,undefined);assert.equal(state.contextOptions.acceptDownloads,false);assert.deepEqual(state.contextOptions.permissions,[]);assert.equal(state.contextOptions.ignoreHTTPSErrors,false);assert.equal(snapshot.title,'Synthetic browser fixture');assert.equal(snapshot.elements[0].ref.startsWith('s'),true);
});
test('missing optional Playwright fails with setup instructions and performs no install',async()=>{
  let imports=0;const tool=new LocalBrowser({loadPlaywright:async()=>{imports++;throw new Error('not installed');}});const pending=await tool.prepare({action:'browser_open',path:'https://example.test/'});await assert.rejects(tool.execute(pending),/No browser or package is installed automatically/);assert.equal(imports,1);await tool.close();
});
test('approved browser actions are one-use and changed targets cannot be clicked',async t=>{
  const {tool,snapshot,state}=await opened(t);const ref=snapshot.elements[0].ref;
  const pending=await tool.prepare({action:'browser_click',query:ref});state.elements[0].label='Different action';await assert.rejects(tool.execute(pending),/approved element or form changed/);assert.equal(state.clicks,0);await assert.rejects(tool.execute(pending),/already used/);
});
test('references expire after another snapshot; clicks bind the exact visible target',async t=>{
  const {tool,snapshot,state}=await opened(t);await tool.snapshot();await assert.rejects(tool.prepare({action:'browser_click',query:snapshot.elements[0].ref}),/stale/);
  const current=await tool.snapshot();const pending=await tool.prepare({action:'browser_click',query:current.elements[0].ref});await tool.execute(pending);assert.equal(state.clicks,1);await assert.rejects(tool.execute(pending),/already used/);
});
test('ordinary browser typing requires approval and no field values reach model snapshots',async t=>{
  const {tool,state}=await opened(t);state.elements[0]={...state.elements[0],tag:'input',type:'text',name:'query',value:'local previous draft'};
  const snapshot=await tool.snapshot();assert(!JSON.stringify(snapshot).includes('local previous draft'));
  const pending=await tool.prepare({action:'browser_type',query:snapshot.elements[0].ref,content:'replacement'});assert.deepEqual(state.fills,[]);assert.equal(pending.review.text,'replacement');await tool.execute(pending);assert.deepEqual(state.fills,['replacement']);
});
test('credential/payment fields and unsafe links cannot become browser interactions',async t=>{
  const {tool,state}=await opened(t);
  for(const patch of [{tag:'input',type:'password'},{tag:'input',type:'file'},{tag:'input',type:'checkbox'},{tag:'input',type:'text',name:'api_token'},{tag:'input',type:'text',autocomplete:'cc-number'},{tag:'input',type:'text',label:'Password'}]){state.elements[0]={...state.elements[0],...patch};const snapshot=await tool.snapshot();await assert.rejects(tool.prepare({action:'browser_type',query:snapshot.elements[0].ref,content:'secret'}),/Enter passwords/);}
  state.elements[0]={...state.elements[0],tag:'a',href:'javascript:alert(1)'};const snapshot=await tool.snapshot();await assert.rejects(tool.prepare({action:'browser_click',query:snapshot.elements[0].ref}),/Only HTTP/);assert.equal(state.clicks,0);
});
test('browser link clicks share navigation URL validation and blocked-origin request routing',async t=>{
  const {tool,state}=await opened(t,{blockedOrigins:['http://127.0.0.1:1234']});
  for(const href of ['https://user:password@example.test/','https://example.test/?api_token=secret','http://127.0.0.1:1234/api/state']){
    state.elements[0]={...state.elements[0],tag:'a',href};const snapshot=await tool.snapshot();await assert.rejects(tool.prepare({action:'browser_click',query:snapshot.elements[0].ref}));
  }
  let aborted=0,continued=0;
  await state.routeHandler({request:()=>({url:()=> 'http://127.0.0.1:1234/api/state'}),abort:async()=>aborted++,continue:async()=>continued++});
  await state.routeHandler({request:()=>({url:()=> 'http://127.0.0.1:4321/fixture'}),abort:async()=>aborted++,continue:async()=>continued++});
  assert.equal(aborted,1);assert.equal(continued,1);assert.equal(state.clicks,0);
});
test('manual cross-origin navigation needs a fresh approved open before extraction',async t=>{
  const {tool,state}=await opened(t);state.url='https://other.example/';await assert.rejects(tool.snapshot(),/another website/);await assert.rejects(tool.screenshot(),/storage is unavailable/);
});
test('screenshots stay local and only known session artifact IDs are readable',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qwen-browser-artifacts-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {tool}=await opened(t,{artifactDir:dir});const image=await tool.screenshot();assert.match(image.note,/not these screenshot pixels/);assert.equal((await tool.screenshotBytes(image.image_id)).toString(),'synthetic-png');await assert.rejects(tool.screenshotBytes('../secret'));
});
test('Stop closes the owned browser during a pending action',async t=>{
  const {tool,state,page}=await opened(t);const abort=new AbortController();const pending=await tool.prepare({action:'browser_open',path:'https://example.test/slow'});
  let release;page.goto=()=>new Promise((resolve,reject)=>{release=reject;state.onClose=()=>reject(new Error('closed'));});
  const action=tool.execute(pending,abort.signal);await until(()=>release);abort.abort(new Error('stopped'));await assert.rejects(action,/stopped/);assert(state.closed>0);
});
test('engine pauses before browser mutation and includes its exact reviewed details',async t=>{
  const fake=fakeBrowser();const browser=new LocalBrowser({loadPlaywright:fake.loadPlaywright});t.after(()=>browser.close());
  const actions=[{action:'browser_open',path:'https://example.test/',message:'Inspect requested website'},{action:'answer',message:'Page inspected'}];
  const engine=new AgentEngine({root:'owned'},async()=>actions.shift(),{browser});const work=engine.start('Inspect requested website');await until(()=>engine.pending);assert.equal(fake.state.launches,0);assert.equal(engine.pending.browser_review.url,'https://example.test/');engine.decide(engine.pending.id,true);await work;assert.equal(fake.state.launches,1);assert.equal(engine.phase,'Task finished');
  assert.throws(()=>actionValue({action:'browser_type',query:'',content:'x',message:'bad'}),/element reference/);
});
