import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {phaseStatus,withTransportProgress,formatProgressStatus} from '../public/js/progress-status.js';
import {setTimeout as delay} from 'node:timers/promises';
import {LiveReply,readLiveReply} from '../src/live.js';

// Run the actual view class with a minimal DOM/animation scheduler. Model and
// network timing are controlled; no screenshot timing or GPU is involved.
class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.dataset={};this.className='';this._text='';this.open=false;this.hidden=false;this.value='';this.style={};this.attributes={};this.scrollHeight=100;this.clientHeight=100;this.scrollTop=0;this.textWrites=0;this.listeners={};this.classList={contains:name=>this.className.split(' ').includes(name),add:name=>{if(!this.classList.contains(name))this.className+=(this.className?' ':'')+name;},remove:name=>{this.className=this.className.split(' ').filter(value=>value!==name).join(' ');},toggle:(name,on)=>on?this.classList.add(name):this.classList.remove(name)};}
  get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
  set textContent(value){this.textWrites++;this._text=String(value);this.children=[];}
  append(...nodes){for(let node of nodes.flat(Infinity)){if(node==null)continue;if(typeof node!=='object'){const text=new Element('text');text.textContent=node;node=text;}node.remove();node.parentNode=this;this.children.push(node);}}
  prepend(...nodes){const old=[...this.children];this.children=[];this.append(...nodes,...old);}
  before(...nodes){if(!this.parentNode)return;const parent=this.parentNode;for(const node of nodes.flat())node.remove();const index=parent.children.indexOf(this);for(const node of nodes.flat()){node.parentNode=parent;}parent.children.splice(index,0,...nodes.flat());}
  after(...nodes){if(!this.parentNode)return;const parent=this.parentNode,index=parent.children.indexOf(this);for(const node of nodes.flat()){node.parentNode=parent;}parent.children.splice(index+1,0,...nodes.flat());}
  remove(){if(this.parentNode){const siblings=this.parentNode.children,index=siblings.indexOf(this);if(index!==-1)siblings.splice(index,1);}this.parentNode=null;}
  replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this._text='';this.append(...nodes);}
  querySelector(selector){const match=node=>selector.startsWith('.')?node.classList.contains(selector.slice(1)):node.tagName===selector.toUpperCase();for(const child of this.children){if(match(child))return child;const nested=child.querySelector(selector);if(nested)return nested;}return null;}
  addEventListener(name,listener){this.listeners[name]=listener;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  removeAttribute(name){delete this.attributes[name];}
  focus(){}
  dispatchEvent(){}
}
const source=(await fs.readFile(new URL('../public/js/thread.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
function fixture(){
  let frameId=0;const frames=new Map();
  const h=(tag,attrs={},...children)=>{const node=new Element(tag);for(const[key,value]of Object.entries(attrs)){if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else node[key]=value;}node.append(...children);return node;};
  const icon=()=>h('svg');const iconButton=(name,label,options={})=>h('button',{class:options.className||'',title:label});
  class MarkdownView{constructor(el){this.el=el;}render(text){this.el.textContent=text;}}
  const raf=callback=>{const id=++frameId;frames.set(id,callback);return id;};const cancel=id=>frames.delete(id);
  const make=new Function('h','icon','iconButton','MarkdownView','prefs','copyFromButton','effortName','tokensShort','clock','requestAnimationFrame','cancelAnimationFrame','setInterval','clearInterval','Event','formatProgressStatus','Date',source+'\nreturn {AssistantView,Thread};');
  const {AssistantView,Thread}=make(h,icon,iconButton,MarkdownView,{get:()=>({reasoningOpen:false})},()=>{},value=>String(value),String,value=>String(value),raf,cancel,()=>1,()=>{},class Event{},formatProgressStatus,{now:()=>1_000_000});
  const thread={actions:{onContinue(){},onRegenerate(){}}};
  const view=new AssistantView(thread,null,{isLast:true});view.startLive();
  return {view,Thread,AssistantView,frames,flush:()=>{const pending=[...frames.values()];frames.clear();for(const frame of pending)frame();}};
}

test('the first reasoning delta is retained and rendered even when it is the only chunk',()=>{
  const {view,flush}=fixture();view.appendThinking('first thought');assert.equal(view.thinking,'first thought');flush();assert.equal(view.thinkingBody.textContent,'first thought');
});
test('continuing a view after finish cancels its old frame and schedules fresh incremental output',()=>{
  const {view,frames,flush}=fixture();view.appendContent('before');assert.equal(frames.size,1);
  view.finish({id:1,status:'length',content:'before',thinking:'',stats:null});assert.equal(frames.size,0);
  view.resume({thinking:false});view.appendContent(' after');assert.equal(frames.size,1);flush();assert.equal(view.body.textContent,'before after');
});
test('long live reasoning stays bounded while every part remains reachable during generation and after completion',()=>{
  const {view,flush}=fixture();const trace=('Thought line.\n\n').repeat(15000)+'TAIL_MARKER';view.appendThinking(trace);flush();
  assert.equal(view.thinking,trace);assert(view.thinkingBody.textContent.length<=24002);assert(view.thinkingBody.textContent.endsWith('TAIL_MARKER'));assert.equal(view.thinkingWindowNote.hidden,false);
  view.thinkingFirst.listeners.click();flush();assert.equal(Number(view.thinkingBody.dataset.traceStart),0);assert(view.thinkingBody.textContent.startsWith('Thought line.'));assert.equal(view.thinkingLatest.hidden,false);
  let end=Number(view.thinkingBody.dataset.traceEnd);while(end<trace.length){view.thinkingNext.listeners.click();flush();assert.equal(Number(view.thinkingBody.dataset.traceStart),end);end=Number(view.thinkingBody.dataset.traceEnd);assert(view.thinkingBody.textContent.length<=24002);}
  assert(view.thinkingBody.textContent.endsWith('TAIL_MARKER'));
  view.appendContent('Answer');flush();assert.equal(view.thinkingWindowNote.hidden,false);assert(view.thinkingBody.textContent.length<=24002);assert.equal(view.thinking,trace);
  const firstParagraph=view.thinkingBody.children[0];view.appendContent(' continues');flush();assert.equal(view.thinkingBody.children[0],firstParagraph);
});
test('scrolling up freezes the visible reasoning and its position while incoming tokens continue',()=>{
  const {view,flush}=fixture();view.appendThinking(('Earlier paragraph.\n\n').repeat(1800));flush();
  const body=view.thinkingBody;body.scrollHeight=2200;body.clientHeight=340;body.scrollTop=400;
  body.listeners.scroll();const visible=body.textContent,first=body.children[0],writes=body.children.reduce((n,node)=>n+node.textWrites,0);
  for(let i=0;i<600;i++){view.appendThinking('next thought '+i+'\n\n');flush();}
  assert.equal(body.scrollTop,400);assert.equal(body.textContent,visible);assert.equal(body.children[0],first);assert.equal(body.children.reduce((n,node)=>n+node.textWrites,0),writes);
  assert.equal(view.thinkingLatest.hidden,false);assert(view.thinking.endsWith('next thought 599\n\n'));
  view.thinkingLatest.listeners.click();flush();assert(body.textContent.includes('next thought 599'));assert.equal(body.scrollTop,body.scrollHeight);assert.equal(view.thinkingLatest.hidden,true);
});
test('an earlier page remains anchored and open when the first answer and final message arrive',()=>{
  const {view,flush}=fixture();view.appendThinking('BEGINNING\n\n'+('Middle thought.\n\n').repeat(4000)+'LATEST');flush();
  view.thinkingFirst.listeners.click();flush();const visible=view.thinkingBody.textContent;view.thinkingBody.scrollTop=190;
  view.appendThinking(' new reasoning');flush();view.appendContent('Answer');flush();
  assert.equal(view.thinkingEl.open,true);assert.equal(view.thinkingBody.textContent,visible);assert.equal(view.thinkingBody.scrollTop,190);
  view.finish({id:1,status:'complete',thinking:view.thinking,content:'Answer',stats:null});assert.equal(view.thinkingEl.open,true);assert.equal(view.thinkingBody.textContent,visible);assert.equal(view.thinkingBody.scrollTop,190);
});
test('scrolling back to the bottom resumes following, and dense trace paragraphs stay bounded',()=>{
  const {view,flush}=fixture();view.appendThinking(('x\n\n').repeat(18000));flush();assert(view.thinkingBody.children.length<=200);
  const body=view.thinkingBody;body.scrollHeight=1800;body.clientHeight=340;body.scrollTop=90;body.listeners.scroll();view.appendThinking('while paused');flush();
  body.scrollTop=1460;body.listeners.scroll();flush();assert(body.textContent.endsWith('while paused'));assert.equal(view.thinkingLatest.hidden,true);
});
test('paging a saved trace preserves emoji pairs and keeps the entire source available',()=>{
  const {AssistantView,flush}=fixture();const source='x'.repeat(23999)+'😀'+('😀 source paragraph\n\n').repeat(5000)+'END';
  const view=new AssistantView({actions:{}},{id:8,thinking:source,content:'saved answer',stats:null,status:'complete'});
  let end=0;
  do {
    const text=view.thinkingBody.textContent;assert.equal(Number(view.thinkingBody.dataset.traceStart),end);end=Number(view.thinkingBody.dataset.traceEnd);
    assert(!/[\uD800-\uDBFF]$/.test(text));assert(!/^[\uDC00-\uDFFF]/.test(text));assert(view.thinkingBody.children.length<=200);assert(text.length<=24002);
    if(end<source.length){view.thinkingNext.listeners.click();flush();}
  }while(end<source.length);
  assert.equal(view.thinking,source);assert(view.thinkingBody.textContent.endsWith('END'));
});
test('a follower displays retry progress without discarding reasoning or answer already received',()=>{
  const {view,flush}=fixture();view.appendThinking('reasoning');view.appendContent('partial answer');flush();
  view.sync({thinking:'reasoning',content:'partial answer',state:'retrying',detail:'Retrying the same model job'});
  assert.equal(view.content,'partial answer');assert.equal(view.thinking,'reasoning');assert(view.liveEl.textContent.includes('Retrying the same model job'));
  view.sync({thinking:'reasoning',content:'partial answer resumes',state:'answering'});flush();assert.equal(view.liveEl,null);assert.equal(view.body.textContent,'partial answer resumes');
});

test('working-note recovery and automatic compaction remain visible beside existing partial text',()=>{
  const {view,flush}=fixture();view.appendThinking('existing thought');flush();
  view.setStatus({state:'recovering',detail:'Preserving unfinished work (2 of 5)'});
  assert(view.liveEl?.textContent.includes('Preserving unfinished work (2 of 5)'));assert.equal(view.thinking,'existing thought');
  view.sync({thinking:'existing thought',content:'',state:'compacting',detail:'Summarizing earlier messages (1 of 3)'});
  assert(view.liveEl.textContent.includes('Summarizing earlier messages (1 of 3)'));assert.equal(view.thinkingBody.textContent,'existing thought');
  view.appendContent('the answer');flush();assert.equal(view.liveEl,null);assert.equal(view.body.textContent,'the answer');
});

test('recovery phase and real retry diagnostics have identical owner and follower labels',()=>{
  const owner=fixture(),follower=fixture();const base=phaseStatus('reasoning_recovery','extracting',{chunk:2,chunks:5});
  owner.view.appendThinking('existing saved thinking');owner.flush();
  for(const transport of [{state:'connecting',detail:'Waiting for the model server to answer',attempt:1},{state:'retrying',detail:'The connection dropped. Retrying in 5 s',attempt:2},{state:'loading',detail:'The server is loading the model',attempt:2}]){
    const status=withTransportProgress(base,transport);
    owner.view.setStatus(status);follower.view.sync({...status,thinking:'existing saved thinking',content:''});
    assert.equal(owner.view.liveEl.querySelector('.live-text').textContent,follower.view.liveEl.querySelector('.live-text').textContent);
    assert(owner.view.liveEl.textContent.includes(formatProgressStatus(status)));
    assert(owner.view.liveEl.textContent.startsWith('Summarizing thinking (2 of 5)'));
    assert.equal(owner.view.thinkingLabel.textContent,'Summarizing thinking (2 of 5)');
    assert.equal(follower.view.thinkingLabel.textContent,owner.view.thinkingLabel.textContent);
    assert(!owner.view.liveEl.textContent.includes('Waiting for the model server'));
  }
});

test('joining during summarization renders existing thought before restoring the active phase',()=>{
  const f=fixture();const status=phaseStatus('reasoning_recovery','extracting',{chunk:1,chunks:3});
  f.view.sync({...status,thinking:'saved thought from before recovery',content:''});f.flush();
  assert.equal(f.view.thinkingBody.textContent,'saved thought from before recovery');
  assert(f.view.liveEl?.textContent.includes('Summarizing thinking (1 of 3)'));
  f.view.sync({operation:'reasoning_recovery',phase:'thinking',state:'thinking',thinking:f.view.thinking,content:'',detail:''});
  assert.equal(f.view.liveEl,null);assert.equal(f.view.thinkingLabel.textContent,'Thinking…');
  f.view.sync({operation:'reasoning_recovery',phase:'thinking',state:'thinking',thinking:'saved thought from before recovery more',content:'',detail:''});f.flush();
  assert.equal(f.view.liveEl,null);assert(f.view.thinking.endsWith(' more'));
  assert.equal(f.view.thinkingLabel.textContent,'Thinking…');
});

test('reading and saving long input use their precise stage rather than a generic model wait',()=>{
  const f=fixture();
  for(const status of [phaseStatus('long_input','reading',{chunk:3,chunks:8}),phaseStatus('long_input','saving'),phaseStatus('long_input','preparing_answer'),phaseStatus('long_input','answering')]){
    f.view.setStatus(status);assert(f.view.liveEl?.textContent.includes(formatProgressStatus(status)));assert(!f.view.liveEl.textContent.includes('Waiting for the model'));
  }
});

test('a followed durable draft is hidden only while its matching live replacement is present',()=>{
  const {view,Thread}=fixture();const root=new Element(),saved=new Element('article'),other=new Element('article');root.append(other,saved,view.el);
  root.querySelector=selector=>selector==='.msg-assistant[data-message-id="17"]'?saved:null;
  const thread=new Thread(root,{});assert.equal(thread.hideFollowedAssistant(view,'17'),null);assert.equal(thread.hideFollowedAssistant(view,18),null);
  const restore=thread.hideFollowedAssistant(view,17);assert.equal(saved.hidden,true);assert.equal(other.hidden,false);assert.deepEqual(root.children,[other,view.el,saved]);
  view.el.remove();restore();assert.equal(saved.hidden,false);assert.deepEqual(root.children,[other,saved]);
});

test('live snapshots carry the exact persisted assistant identity without exposing the owner token',async()=>{
  let row=null;const db={prepare(sql){return {bind(...args){return {async run(){if(sql.startsWith('INSERT'))row={v:args[1]};else if(sql.startsWith('DELETE'))row=null;return {};},async first(){return row;}};}};}};
  const live=new LiveReply(db,{owner:'private-owner',chatId:'chat',userMessageId:3,assistantMessageId:17,thinking:'saved reasoning'});
  try{
    await delay(15);let snapshot=await readLiveReply(db,'chat');assert.equal(snapshot.assistant_message_id,17);assert.equal(snapshot.owner,undefined);
    live.update({assistantMessageId:21,state:'recovering',detail:'Working notes saved'});await delay(850);snapshot=await readLiveReply(db,'chat');assert.equal(snapshot.assistant_message_id,21);assert.equal(snapshot.thinking,'saved reasoning');assert.equal(snapshot.detail,'Working notes saved');
    assert.equal(await readLiveReply(db,'other'),null);
  }finally{await live.finish();}
  assert.equal(await readLiveReply(db,'chat'),null);
});

const composerSource=(await fs.readFile(new URL('../public/js/composer.js',import.meta.url),'utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
test('reasoning effort controls stay fixed during generation/preparation and apply cleanly afterward',()=>{
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const label=new Element('span');label.className='think-label';get('think').append(label);
  const h=(tag,attrs={},...children)=>{const node=new Element(tag);for(const[key,value]of Object.entries(attrs)){if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else node[key]=value;}node.append(...children);return node;};
  let menu=null,opened=0;
  const make=new Function('h','icon','isTouch','storage','closePopover','openPopover','prefs','window','document','MAX_TOTAL_CHARS',composerSource+'\nreturn {Composer,EFFORTS};');
  const {Composer,EFFORTS}=make(h,()=>h('svg'),()=>false,{get:()=>null,set:()=>{}},()=>{},(button,content)=>{opened++;menu=content;return null;},{get:()=>({sendKey:'enter'})},{innerHeight:900},{getElementById:get},120000);
  assert.deepEqual(EFFORTS.map(e=>e.think),[false,'low','medium',true]);
  const composer=new Composer({onSend(){},onStop(){},onError(){}});
  assert.equal(composer.think,'medium');get('think').listeners.click();assert.equal(opened,1);
  const quick=menu.children.find(node=>node.tagName==='BUTTON'&&node.dataset.effort==='low');
  composer.setGenerating(true);assert.equal(get('think').disabled,true);get('think').listeners.click();assert.equal(opened,1);quick.listeners.click();assert.equal(composer.think,'medium');
  composer.setGenerating(false);assert.equal(get('think').disabled,false);quick.listeners.click();assert.equal(composer.think,'low');
  composer.setPreparing(true);assert.equal(get('think').disabled,true);composer.setPreparing(false);assert.equal(get('think').disabled,false);
});

test('ordinary Continue preserves the composer Off choice all the way to its API request',async()=>{
  const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const handler=app.match(/async function continueReply\([\s\S]+?\n\}/)?.[0];assert(handler);
  let requestedThink,resumeOptions;const message={id:8,content:'partial',thinking:'trace'};
  const state={generation:null,compaction:null,chat:{id:'chat'},messages:[message]};
  const noop=()=>{};const view={resume:options=>{resumeOptions=options;},finish:noop,markStopped:noop};
  const fixture={state,composer:{think:false,setGenerating:noop,setStopping:noop},stopFollow:noop,hideNotice:noop,syncAnswerNow:noop,sidebar:{setGenerating:noop},status:{refresh:noop},wakeLock:{acquire:noop,release:noop},announce:noop,updateChat:noop,telemetry:{setChat:noop},contextView:{refresh:noop},
    api:{async *continueReply(_id,_signal,think){requestedThink=think;yield {event:'start',chat:state.chat};yield {event:'done',message,chat:state.chat};}},handleEvent(generation,event){if(event.event==='done')generation.finished=true;}};
  const run=new Function('fixture','with(fixture){'+handler+'; return continueReply;}')(fixture);
  await run(message,view);assert.equal(requestedThink,false);assert.deepEqual(resumeOptions,{thinking:false});assert.equal(state.generation,null);
});
