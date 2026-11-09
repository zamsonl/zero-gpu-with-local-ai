import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';

class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.dataset={};this.className='';this.textContent='';this.hidden=false;this.value='';this.style={};this.attributes={};this.listeners={};this.scrollHeight=100;this.classList={contains:name=>this.className.split(' ').includes(name),add:name=>{if(!this.classList.contains(name))this.className+=' '+name;},remove:name=>{this.className=this.className.split(' ').filter(v=>v!==name).join(' ');},toggle:(name,on)=>on?this.classList.add(name):this.classList.remove(name)};}
  append(...nodes){for(const node of nodes.flat(Infinity)){if(!node)continue;node.parentNode=this;this.children.push(node);}}
  prepend(...nodes){const old=this.children;this.children=[];this.append(...nodes,...old);}
  before(...nodes){if(!this.parentNode)return;const index=this.parentNode.children.indexOf(this);for(const node of nodes)node.parentNode=this.parentNode;this.parentNode.children.splice(index,0,...nodes);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  querySelector(selector){for(const node of this.children){if(selector.startsWith('.')&&node.classList.contains(selector.slice(1)))return node;const child=node.querySelector(selector);if(child)return child;}return null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(name,callback){(this.listeners[name]??=[]).push(callback);}
  emit(name,props={}){const event={preventDefault(){},...props};for(const fn of this.listeners[name]??[])fn(event);}
  getBoundingClientRect(){return {height:Number.parseFloat(this.style.height)||64};}
  focus(){} setPointerCapture(){} releasePointerCapture(){}
}
const composerSource=(await fs.readFile(new URL('../public/js/composer.js',import.meta.url),'utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const handler=name=>{const source=app.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'))?.[0];assert(source,'Missing '+name);return source;};
const noop=()=>{};
test('New conversation exits Images even when no chat was selected, while an existing new-chat draft stays focused',()=>{
  for(const images of [true,false]){
    const navigated=[];let focused=0,closed=0;
    const fixture={state:{chat:null,generation:null,compaction:null},sidebar:{closeDrawer:()=>closed++},composer:{focus:()=>focused++},isImagesRoute:()=>images,go:path=>navigated.push(path)};
    const run=new Function('fixture','with(fixture){'+handler('newChat')+';return newChat;}')(fixture);
    run();assert.equal(closed,1);assert.deepEqual(navigated,images?['/']:[]);assert.equal(focused,images?0:1);
  }
});
function composerFixture({readFile=async file=>({name:file.name,type:'text/plain',text:'file body'}),onSend=noop,saved=new Map()}={}){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const label=new Element('span');label.className='think-label';get('think').append(label);get('composer').append(get('prompt'));
  const h=(tag,props={},...children)=>{const el=new Element(tag);for(const[key,value]of Object.entries(props)){if(key==='class')el.className=value;else if(key==='text')el.textContent=value;else if(key==='dataset')Object.assign(el.dataset,value);else el.setAttribute(key,value);}el.append(...children);return el;};
  let menu;
  const window={innerHeight:900,listeners:{},addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);},visualViewport:{height:900,addEventListener:noop}};
  const make=new Function('h','icon','isTouch','storage','closePopover','openPopover','prefs','window','document','MAX_TOTAL_CHARS','MAX_FILES','MAX_PICTURES','readFile','isPictureAttachment','pictureUrl','formatChars','FileRejected',composerSource+'\nreturn Composer;');
  const Composer=make(h,()=>h('svg'),()=>false,{get:key=>saved.get(key)??null,set:(key,value)=>value==null?saved.delete(key):saved.set(key,value)},noop,(_button,content)=>{menu=content;return content;},{get:()=>({sendKey:'enter'})},window,{getElementById:get},120000,10,4,readFile,file=>Boolean(file.data),file=>file.data,String,class FileRejected extends Error{});
  const composer=new Composer({onSend,onStop:noop,onError:noop,onChange:noop});
  return {composer,get,window,saved,type(text){get('prompt').value=text;get('prompt').emit('input');},chooseEffort(id){get('think').emit('click');const item=menu?.children.find(item=>item.dataset.effort===id);assert(item,'Missing effort '+id);item.emit('click');}};
}
function appFixture(composer,overrides={}){
  const state={chat:{id:'a'},messages:[],generation:null,compaction:null,longInputPreparing:false,loadAbort:null};
  const fixture={state,composer,leaveImages:noop,stopFollow:noop,closePopover:noop,hideNotice:noop,syncAnswerNow:noop,sidebar:{setActive:noop,closeDrawer:noop,find:id=>({id}),remove:noop},longInputView:{setSources:noop,sources:[]},setTitle:noop,thread:{render:noop,showEmpty:noop},telemetry:{setChat:noop,render:noop},contextView:{refresh:noop},els:{jump:{},thread:new Element(),conversation:new Element()},status:{status:{},refresh:async()=>{}},api:{getChat:async id=>({chat:{id},messages:[]})},modelLabel:()=>'',contextReady:()=>false,loadingPlaceholder:()=>new Element(),decorateLongInputSources:noop,location:{origin:'https://owned.example'},loadLongInputs:noop,scrollToBottom:noop,syncFollow:noop,ApiError:class ApiError extends Error{},showNotice:noop,toast:noop,navigate:noop,...overrides};
  const run=new Function('fixture','with(fixture){'+handler('openChat')+';return openChat;}')(fixture);
  return {fixture,state,openChat:run};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function sendFixture(ui,{route={id:'a'},createChat,turn}={}){
  const {fixture,state,openChat}=appFixture(ui.composer);
  const calls=[],deleted=[],view={el:new Element(),finish:noop,markStopped:noop,setStatus:noop};
  Object.assign(fixture,{currentChatId:()=>route.id,isImagesRoute:()=>false,newChatId:()=> 'created',chatPath:id=>'/c/'+id,
    navigate:path=>{route.id=path==='/'?null:path.split('/').at(-1);},wakeLock:{acquire:noop,release:noop},announce:noop,describeSendError:error=>error.message,refreshCurrent:noop,
    handleEvent(generation,event){if(event.event==='start')generation.started=true;if(event.event==='done')generation.finished=true;}});
  Object.assign(fixture.thread,{appendPendingUser:()=>({message:{},el:new Element()}),appendLiveAssistant:()=>view,truncateFrom:noop});
  Object.assign(fixture.sidebar,{setGenerating:noop,upsert:noop});
  Object.assign(fixture.api,{createChat:createChat??(async()=>({id:'created'})),deleteChat:async id=>{deleted.push(id);},turn:async function*(id,body,signal){calls.push({id,body,signal});yield*turn(id,body,signal);}});
  const run=new Function('fixture','with(fixture){'+handler('rollBack')+'\n'+handler('send')+';return send;}')(fixture);
  return {fixture,state,openChat,send:run,calls,deleted,route};
}

test('real openChat call sites isolate typed drafts across two chats and the new-chat route',async()=>{
  const ui=composerFixture(),{openChat}=appFixture(ui.composer);
  await openChat('a');ui.type('private draft A');await openChat('b');assert.equal(ui.composer.value,'');
  ui.type('draft B');await openChat(null);assert.equal(ui.composer.value,'');ui.type('brand new draft');
  await openChat('a');assert.equal(ui.composer.value,'private draft A');await openChat('b');assert.equal(ui.composer.value,'draft B');await openChat(null);assert.equal(ui.composer.value,'brand new draft');
});

test('the real thinking picker remembers each chat separately while switching and reloading',async()=>{
  const saved=new Map(),ui=composerFixture({saved}),{openChat}=appFixture(ui.composer);
  await openChat('a');ui.chooseEffort('off');assert.equal(ui.composer.think,false);
  await openChat('b');assert.equal(ui.composer.effort,'medium');ui.chooseEffort('deep');
  await openChat(null);assert.equal(ui.composer.effort,'medium');ui.chooseEffort('low');
  await openChat('a');assert.equal(ui.composer.think,false);assert.equal(ui.get('think').dataset.effort,'off');
  await openChat('b');assert.equal(ui.composer.think,true);assert.equal(ui.get('think').querySelector('.think-label').textContent,'Deep');
  await openChat(null);assert.equal(ui.composer.think,'low');
  const reload=composerFixture({saved}),restored=appFixture(reload.composer);
  await restored.openChat('b');assert.equal(reload.composer.think,true);
  await restored.openChat('a');assert.equal(reload.composer.think,false);
  await restored.openChat(null);assert.equal(reload.composer.think,'low');
});

test('legacy thinking defaults remain valid and visited chats keep their inherited mode',()=>{
  const saved=new Map([['qwen.think','deep']]),ui=composerFixture({saved});
  ui.composer.switchDraft('legacy');assert.equal(ui.composer.think,true);
  ui.composer.switchDraft(null);ui.chooseEffort('off');
  const reload=composerFixture({saved});reload.composer.switchDraft('legacy');assert.equal(reload.composer.think,true);
  reload.composer.switchDraft('unvisited');assert.equal(reload.composer.think,false);
  assert.equal(saved.get('qwen.think'),'off');
});

test('invalid stored thinking modes fall back safely without changing unrelated settings',()=>{
  const saved=new Map([['qwen.think','not-an-effort'],['qwen.think.chat:a','also-invalid'],['qwen.prefs','preserve-me']]);
  const ui=composerFixture({saved});ui.composer.switchDraft('a');assert.equal(ui.composer.effort,'medium');
  ui.chooseEffort('low');ui.composer.switchDraft('b');assert.equal(ui.composer.effort,'medium');
  assert.equal(saved.get('qwen.prefs'),'preserve-me');assert.equal(saved.get('qwen.think'),'not-an-effort');
});

test('saving a new chat adopts its mode and deleting it removes only its saved mode',()=>{
  const saved=new Map(),ui=composerFixture({saved});ui.chooseEffort('deep');ui.composer.adoptDraft('created');
  const reload=composerFixture({saved});reload.composer.switchDraft('created');assert.equal(reload.composer.think,true);
  reload.chooseEffort('off');reload.composer.switchDraft('other');reload.chooseEffort('low');
  reload.composer.forgetDraft('created');
  assert(!saved.has('qwen.think.chat:created'));assert.equal(saved.get('qwen.think.chat:other'),'low');assert.equal(saved.get('qwen.think'),'deep');
  const reopened=composerFixture({saved});reopened.composer.switchDraft('created');assert.equal(reopened.composer.think,true);
});

test('sending from each restored chat uses that chat\'s selected thinking mode',async()=>{
  const ui=composerFixture(),call=sendFixture(ui,{turn:async function*(){yield {event:'start'};yield {event:'done'};}});
  await call.openChat('a');ui.chooseEffort('off');call.route.id='b';await call.openChat('b');ui.chooseEffort('deep');
  call.route.id='a';await call.openChat('a');await call.send('plain answer');
  call.route.id='b';await call.openChat('b');await call.send('reason carefully');
  assert.deepEqual(call.calls.map(call=>({id:call.id,think:call.body.think})),[{id:'a',think:false},{id:'b',think:true}]);
});

test('real chat navigation permanently cancels automatic work handoffs even after returning',async()=>{
  const ui=composerFixture(),{openChat,state}=appFixture(ui.composer);
  state.generation={chatId:'a',view:{el:new Element()}};
  await openChat('b');assert.equal(state.generation.autoContinuationCancelled,true);
  await openChat('a');assert.equal(state.generation.autoContinuationCancelled,true);
});

test('new chat resets the previous conversation scroll before showing its welcome',async()=>{
  const ui=composerFixture(),call=appFixture(ui.composer);
  call.fixture.els.conversation.scrollTop=750;call.state.stickToBottom=false;
  await call.openChat(null);
  assert.equal(call.fixture.els.conversation.scrollTop,0);assert.equal(call.state.stickToBottom,true);
});

test('returning during continuation renders the active assistant once and keeps full saved history',async()=>{
  const ui=composerFixture(),call=appFixture(ui.composer),rendered=[];
  const view={el:new Element()};view.el.dataset.messageId='99';
  const messages=[{id:7,role:'user'},{id:99,role:'assistant',status:'length'}];
  call.fixture.thread.render=items=>rendered.push(items);
  call.fixture.api.getChat=async()=>({chat:{id:'a'},messages});
  call.state.generation={chatId:'a',view};
  await call.openChat('a');
  assert.deepEqual(rendered.at(-1).map(message=>message.id),[7]);
  assert.deepEqual(call.state.messages.map(message=>message.id),[7,99]);
  assert.equal(call.fixture.els.thread.children.filter(child=>child===view.el).length,1);
});

test('a generation finishing during chat load renders the durable final reply without its stale live view',async()=>{
  const ui=composerFixture(),call=appFixture(ui.composer),load=deferred(),rendered=[];
  const view={el:new Element()};view.el.dataset.messageId='99';
  call.state.generation={chatId:'a',view};call.fixture.api.getChat=()=>load.promise;
  call.fixture.thread.render=items=>rendered.push(items);
  const task=call.openChat('a');call.state.generation=null;
  load.resolve({chat:{id:'a'},messages:[{id:99,role:'assistant',status:'complete'}]});await task;
  assert.deepEqual(rendered.at(-1).map(message=>message.id),[99]);
  assert(!call.fixture.els.thread.children.includes(view.el));
});

test('typing preserves a manually enlarged prompt rather than growing or resetting it',()=>{
  const ui=composerFixture();ui.get('prompt').style.height='240px';ui.get('prompt').emit('pointerup');ui.type('a\n'.repeat(100));assert.equal(ui.get('prompt').style.height,'240px');
});

test('pending file reads complete in their original chat and removals never reappear',async()=>{
  const read=deferred(),ui=composerFixture({readFile:()=>read.promise});ui.composer.switchDraft('a');
  const adding=ui.composer.addFiles([{name:'owned.txt'}]);assert.equal(ui.composer.attachments[0].reading,true);
  ui.composer.switchDraft('b');assert.equal(ui.composer.attachments.length,0);read.resolve({name:'owned.txt',type:'text/plain',text:'private A file'});await adding;
  assert.equal(ui.composer.attachments.length,0);ui.composer.switchDraft('a');assert.equal(ui.composer.attachments[0].text,'private A file');
  ui.get('attachments').children[0].children.at(-1).emit('click');ui.composer.switchDraft('b');ui.composer.switchDraft('a');assert.equal(ui.composer.attachments.length,0);
});

test('versioned clear and rollback never overwrite a newer edit, even when text matches again',()=>{
  const ui=composerFixture();ui.composer.switchDraft('a');ui.type('submitted');const snapshot=ui.composer.captureDraft(),cleared=ui.composer.clearDraft(snapshot);
  ui.type('new draft');ui.composer.restoreDraft(snapshot,cleared);assert.equal(ui.composer.value,'new draft');
  const second=ui.composer.captureDraft();ui.type('changed');ui.type('new draft');assert.equal(ui.composer.clearDraft(second),null);assert.equal(ui.composer.value,'new draft');
});

test('real submit/send rollback restores text and attachments to the sent chat after navigation',async()=>{
  const gate=deferred();let task;let send;
  const ui=composerFixture({onSend:(text,files,snapshot)=>{task=send(text,{attachments:files,draftSnapshot:snapshot});}});
  const call=sendFixture(ui,{turn:async function*(){await gate.promise;}});send=call.send;
  await call.openChat('a');ui.type('original A');await ui.composer.addFiles([{name:'a.txt'}]);ui.get('composer').emit('submit');assert.equal(ui.composer.value,'');
  call.route.id='b';await call.openChat('b');ui.type('B stays private');gate.reject(new Error('network failure'));await task;
  assert.equal(ui.composer.value,'B stays private');assert.equal(ui.composer.attachments.length,0);
  call.route.id='a';await call.openChat('a');assert.equal(ui.composer.value,'original A');assert.equal(ui.composer.attachments[0].name,'a.txt');
});

test('real send completion preserves text typed after submit and another chat draft',async()=>{
  const gate=deferred(),ui=composerFixture();const call=sendFixture(ui,{turn:async function*(){await gate.promise;yield {event:'start'};yield {event:'done'};}});
  await call.openChat('a');ui.type('submitted');const task=call.send('submitted',{draftSnapshot:ui.composer.captureDraft()});ui.type('next A');call.route.id='b';await call.openChat('b');ui.type('next B');gate.resolve();await task;
  assert.equal(ui.composer.value,'next B');call.route.id='a';await call.openChat('a');assert.equal(ui.composer.value,'next A');
});

test('new-chat create race never navigates over the chat opened while it was pending',async()=>{
  const create=deferred(),ui=composerFixture(),call=sendFixture(ui,{route:{id:null},createChat:()=>create.promise,turn:async function*(){assert.fail('No inference after navigation.');}});
  await call.openChat(null);ui.type('unsent new conversation');const task=call.send(ui.composer.value,{draftSnapshot:ui.composer.captureDraft()});
  call.route.id='b';await call.openChat('b');ui.type('stay in B');create.resolve({id:'created'});await task;
  assert.equal(call.state.chat.id,'b');assert.equal(ui.composer.value,'stay in B');assert.deepEqual(call.deleted,['created']);assert.equal(call.calls.length,0);
  call.route.id=null;await call.openChat(null);assert.equal(ui.composer.value,'unsent new conversation');
});

test('new-chat migration keeps newer text and rejects duplicate sends during creation',async()=>{
  const create=deferred(),gate=deferred(),ui=composerFixture(),call=sendFixture(ui,{route:{id:null},createChat:()=>create.promise,turn:async function*(){await gate.promise;}});
  await call.openChat(null);ui.type('sent text');const task=call.send('sent text',{draftSnapshot:ui.composer.captureDraft()});ui.type('newer text');await call.send('duplicate',{draftSnapshot:ui.composer.captureDraft()});
  create.resolve({id:'created'});await new Promise(resolve=>setImmediate(resolve));assert.equal(ui.composer.draftKey,'chat:created');assert.equal(ui.composer.value,'newer text');assert.equal(call.calls.length,1);
  gate.reject(new Error('not accepted'));await task;assert.equal(ui.composer.value,'newer text');ui.composer.switchDraft(null);assert.equal(ui.composer.value,'');
});

test('late chat loads cannot switch drafts back or allow sends into the old chat',async()=>{
  const load=deferred(),ui=composerFixture();const call=sendFixture(ui,{turn:async function*(){assert.fail('Loading chats cannot send.');}});
  call.fixture.api.getChat=async id=>id==='a'?load.promise:{chat:{id},messages:[]};
  const a=call.openChat('a');ui.type('A pending');await call.send('blocked',{draftSnapshot:ui.composer.captureDraft()});assert.equal(ui.composer.value,'A pending');
  call.route.id='b';await call.openChat('b');ui.type('B current');load.resolve({chat:{id:'a'},messages:[]});await a;assert.equal(ui.composer.value,'B current');assert.equal(call.state.chat.id,'b');
});

test('real long-input upload clears only its submitted snapshot after navigation or newer edits',async()=>{
  for(const navigate of [true,false]){
    const upload=deferred(),ui=composerFixture(),call=sendFixture(ui,{turn:async function*(){}});await call.openChat('a');ui.type('large submitted input');await ui.composer.addFiles([{name:'source.txt'}]);
    Object.assign(call.fixture,{pendingLongUpload:null,longInputPlan:()=>({needed:true,allowed:true,totalChars:130000}),confirmLongInput:async()=>true,sourceProgress:()=>'',crypto:globalThis.crypto,updateChat:noop,runLongInputSteps:async()=>({complete:true})});
    Object.assign(call.fixture.longInputView,{render:noop,updateSource:noop});call.fixture.api.createLongInput=()=>upload.promise;
    const process=new Function('fixture','with(fixture){'+handler('processLongInput')+';return processLongInput;}')(call.fixture);
    const task=process();await new Promise(resolve=>setImmediate(resolve));
    if(navigate){call.route.id='b';await call.openChat('b');ui.type('B unsent');}else ui.type('A newer unsent');
    upload.resolve({source:{id:'source',chat_id:'a'},chat:{id:'a'},user_message:{id:7}});await task;
    assert.equal(ui.composer.value,navigate?'B unsent':'A newer unsent');
    if(navigate){call.route.id='a';await call.openChat('a');assert.equal(ui.composer.value,'');assert.equal(ui.composer.attachments.length,0);}else assert.equal(ui.composer.attachments[0].name,'source.txt');
  }
});

test('edit/regenerate resend preserves an unrelated composer draft and its attachments',async()=>{
  const ui=composerFixture(),call=sendFixture(ui,{turn:async function*(){throw new Error('not accepted');}});await call.openChat('a');ui.type('separate unsent draft');await ui.composer.addFiles([{name:'unsent.txt'}]);
  await call.send('edited historical message',{replaceFrom:{id:5},attachments:[]});assert.equal(ui.composer.value,'separate unsent draft');assert.equal(ui.composer.attachments[0].name,'unsent.txt');
  ui.type('');await call.send('edited again',{replaceFrom:{id:5},attachments:[]});assert.equal(ui.composer.value,'');assert.equal(ui.composer.attachments[0].name,'unsent.txt');
});

test('resize handle supports keyboard/pointer bounds, stays fixed while typing, and fits a mobile keyboard',()=>{
  const ui=composerFixture(),handle=ui.composer.resizeHandle;assert.equal(ui.get('prompt').style.height,'64px');assert.equal(handle.getAttribute('role'),'separator');assert.equal(handle.getAttribute('aria-controls'),'prompt');
  handle.emit('keydown',{key:'ArrowUp'});assert.equal(ui.get('prompt').style.height,'88px');handle.emit('keydown',{key:'End'});assert.equal(ui.get('prompt').style.height,'495px');
  handle.emit('pointerdown',{button:0,pointerId:1,clientY:200});handle.emit('pointermove',{clientY:600});handle.emit('pointerup',{pointerId:1});assert.equal(ui.get('prompt').style.height,'95px');
  handle.emit('keydown',{key:'Home'});assert.equal(ui.get('prompt').style.height,'64px');handle.emit('keydown',{key:'End'});ui.type('many\n'.repeat(500));assert.equal(ui.get('prompt').style.height,'495px');
  ui.window.visualViewport.height=200;ui.window.listeners.resize[0]();assert.equal(ui.get('prompt').style.height,'110px');ui.window.visualViewport.height=900;ui.window.listeners.resize[0]();assert.equal(ui.get('prompt').style.height,'495px');
  assert(![...ui.saved.keys()].some(key=>key.includes('draft')),'Draft content must not enter shared storage.');
});
