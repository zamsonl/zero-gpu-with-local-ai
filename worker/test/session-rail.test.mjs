import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';

const source=(await fs.readFile(new URL('../public/js/session-rail.js',import.meta.url),'utf8')).replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.style={};this.listeners={};this.inert=false;this.hidden=false;this.disabled=false;this.isConnected=true;this.parentElement=null;this.ownText='';this.className='';this.classList={add:value=>this.className+=' '+value,remove:value=>{this.className=this.className.split(' ').filter(item=>item!==value).join(' ');}};}
  set textContent(value){this.ownText=String(value);this.children=[];}get textContent(){return this.ownText+this.children.map(item=>item.textContent??item).join('');}
  append(...items){for(const item of items.flat(Infinity).filter(item=>item!=null)){item.parentElement=this;this.children.push(item);}}
  replaceChildren(...items){this.children=[];this.ownText='';this.append(...items);}
  setAttribute(key,value){this.attributes[key]=String(value);if(key==='disabled')this.disabled=true;}removeAttribute(key){delete this.attributes[key];}getAttribute(key){return this.attributes[key]??null;}
  addEventListener(key,fn){(this.listeners[key]??=[]).push(fn);}fire(key,event={}){for(const fn of this.listeners[key]??[])fn({target:this,preventDefault(){this.defaultPrevented=true;},...event});}
  contains(target){return target===this||this.children.some(item=>item.contains?.(target));}focus(){this.document.activeElement=this;}getClientRects(){return this.hidden?[]:[{}];}
  querySelectorAll(){return this.children.flatMap(item=>[...(['BUTTON','A','SUMMARY'].includes(item.tagName)?[item]:[]),...(item.querySelectorAll?.()??[])]);}
}
function fixture({memory=async()=>({memory:null}),snapshot={}}={}){
  const nodes=new Map(),doc={activeElement:null,getElementById:id=>nodes.get(id)??null,querySelector:()=>null,addEventListener(key,fn){(this.listeners[key]??=[]).push(fn);},listeners:{}};
  const make=(tag,props={},...children)=>{const el=new Element(tag);el.document=doc;for(const[key,value]of Object.entries(props)){if(value==null||value===false)continue;if(key==='class')el.className=value;else if(key==='text')el.textContent=value;else if(key.startsWith('on'))el.addEventListener(key.slice(2),value);else el.setAttribute(key,value===true?'':value);}el.append(...children);return el;};
  for(const id of ['session-rail','session-content','session-toggle','session-close','session-backdrop','nav-documents','sidebar','main','conversation','dock','topbar'])nodes.set(id,make(id.includes('toggle')||id.includes('close')?'button':'div'));
  doc.body=make('body');doc.body.append(nodes.get('sidebar'),nodes.get('main'),nodes.get('session-backdrop'));nodes.get('main').append(nodes.get('topbar'),nodes.get('conversation'),nodes.get('dock'),nodes.get('session-rail'));nodes.get('session-rail').append(nodes.get('session-close'),nodes.get('session-content'));
  const media={matches:true,addEventListener(){}};
  const server={server:'ready',num_ctx:98304,host:'kaggle',quant:'Q5_K_P'};
  const state={chatId:'a',messages:[],attachments:[],sources:[],context:{can_compact:true,estimated_input_tokens:24000,input_budget_tokens:71680},...snapshot};
  const status={status:server,busyElsewhere:null,addEventListener(){}};
  const previews=[];
  const env={api:{memory},h:make,icon:()=>make('svg'),contextReady:status=>['ready','idle','images'].includes(status?.server)&&Number.isInteger(status?.num_ctx),formatChars:value=>`${value} characters`,downloadBlob(){},viewFile:file=>previews.push(file),isPopoverOpen:()=>false,toast(){},document:doc,window:{matchMedia:()=>media}};
  const exports=new Function('env','with(env){'+source+';return {SessionRail,sessionContext,conversationFiles,memoryNotes};}')(env);
  let compacts=0;const rail=new exports.SessionRail({status,snapshot:()=>state,onCompact:()=>compacts++});
  return {exports,rail,doc,nodes,media,state,status,previews,compacts:()=>compacts,text:()=>nodes.get('session-content').textContent,buttons:()=>nodes.get('session-content').querySelectorAll().filter(item=>item.tagName==='BUTTON')};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}

test('context uses the actual input budget and disables compaction while busy, offline or in pictures',()=>{
  const f=fixture(),context=f.exports.sessionContext;
  assert.equal(context(f.state,f.status.status).fraction,24000/71680);assert.equal(context(f.state,f.status.status).canCompact,true);
  for(const change of [{busy:true},{images:true},{chatId:null}])assert.equal(context({...f.state,...change},f.status.status).canCompact,false);
  assert.equal(context(f.state,{server:'unregistered',num_ctx:24576}).used,null);assert.equal(context(f.state,f.status.status,true).canCompact,false);
});
test('documents preserve message identity, pending reads and exact long-input ownership',()=>{
  const f=fixture();const files=f.exports.conversationFiles({chatId:'a',messages:[{id:1,attachments:[{name:'same.txt',text:'first'}]},{id:2,attachments:[{name:'same.txt',text:'second'}]}],attachments:[{name:'pending.pdf',reading:true}],sources:[{id:'owned',chat_id:'a',total_chars:5000,processed_chunks:1,total_chunks:3},{id:'other',chat_id:'b'}]});
  assert.equal(files.length,4);assert.notEqual(files[0].key,files[1].key);assert.equal(files[2].detail,'Reading attachment…');assert.equal(files[3].source.id,'owned');
});
test('memory preview parses exact quoted notes without interpreting markup or inventing notes',()=>{
  const f=fixture();const summary='[Memory update]\n- [corrections] '+JSON.stringify('port 8247; <img onerror=bad>')+'\n- [facts] invalid JSON';
  assert.deepEqual(f.exports.memoryNotes(summary),[{kind:'corrections',text:'port 8247; <img onerror=bad>'}]);assert.deepEqual(f.exports.memoryNotes(),[]);
});
test('late memory for chat A cannot appear in chat B and repeat renders start no new requests',async()=>{
  const a=deferred(),b=deferred(),calls=[];const f=fixture({memory:(id,signal)=>{calls.push({id,signal});return id==='a'?a.promise:b.promise;}});
  f.state.chatId='b';f.rail.refresh();assert.equal(calls[0].signal.aborted,true);
  b.resolve({memory:{summary:'- [facts] "B exact note"',covered_count:6,through_id:9}});await tick();
  a.resolve({memory:{summary:'- [facts] "A private note"',covered_count:7,through_id:11}});await tick();
  assert(f.text().includes('B exact note'));assert(!f.text().includes('A private note'));f.rail.refresh();assert.equal(calls.length,2);
});
test('compact and review controls keep their identity across status and counter updates',async()=>{
  const f=fixture();await tick();const buttons=f.buttons();f.doc.activeElement=buttons[0];f.state.context.estimated_input_tokens=27000;f.rail.refresh();
  assert.deepEqual(f.buttons(),buttons);assert.equal(f.doc.activeElement,buttons[0]);buttons[0].fire('click');assert.equal(f.compacts(),1);
});

test('switching conversations restores the session heading and shows current vision capability',()=>{
  const f=fixture();f.nodes.get('session-rail').scrollTop=400;
  f.state.chatId='b';f.status.status.vision=true;f.rail.refresh();
  assert.equal(f.nodes.get('session-rail').scrollTop,0);assert(f.text().includes('On · attach pictures'));
});
test('opening mobile Session inerts only background siblings and restores their prior state',()=>{
  const f=fixture();f.nodes.get('dock').inert=true;f.rail.open();
  assert.equal(f.nodes.get('main').inert,false);assert.equal(f.nodes.get('session-rail').inert,false);assert.equal(f.nodes.get('conversation').inert,true);assert.equal(f.nodes.get('sidebar').inert,true);assert.equal(f.nodes.get('session-toggle').getAttribute('aria-expanded'),'true');
  f.rail.close();assert.equal(f.nodes.get('conversation').inert,false);assert.equal(f.nodes.get('dock').inert,true);assert.equal(f.nodes.get('sidebar').inert,false);assert.equal(f.doc.activeElement,f.nodes.get('session-toggle'));
});
test('desktop Session starts collapsed and opens as the same accessible drawer without reserving background focus',()=>{
  const f=fixture();f.media.matches=false;
  assert.equal(f.nodes.get('session-toggle').getAttribute('aria-expanded'),'false');
  assert(!f.nodes.get('session-rail').className.includes('is-open'));
  f.nodes.get('session-toggle').fire('click');
  assert.equal(f.nodes.get('session-rail').getAttribute('role'),'dialog');
  assert.equal(f.nodes.get('session-rail').getAttribute('aria-modal'),'true');
  assert.equal(f.nodes.get('conversation').inert,true);assert.equal(f.nodes.get('session-backdrop').hidden,false);
  f.rail.open(); // Repeated opens must not overwrite the original inert state.
  for(const handler of f.doc.listeners.keydown)handler({key:'Escape',defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}});
  assert.equal(f.nodes.get('session-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(f.nodes.get('conversation').inert,false);assert.equal(f.nodes.get('session-backdrop').hidden,true);
  assert.equal(f.doc.activeElement,f.nodes.get('session-toggle'));
});
test('reloaded same-name attachments preview their current content while unchanged file nodes stay stable',()=>{
  const oldFile={name:'code.txt',text:'old'};const f=fixture({snapshot:{messages:[{id:1,attachments:[oldFile]}]}});
  const original=f.buttons().find(button=>button.getAttribute('title')==='View code.txt');f.rail.refresh();assert.equal(f.buttons().find(button=>button.getAttribute('title')==='View code.txt'),original);
  const newFile={name:'code.txt',text:'new'};f.state.messages=[{id:1,attachments:[newFile]}];f.rail.refresh();
  const current=f.buttons().find(button=>button.getAttribute('title')==='View code.txt');assert.notEqual(current,original);current.fire('click');assert.equal(f.previews[0],newFile);
});
test('missing memory is honest and a failed load offers a bounded explicit retry',async()=>{
  let calls=0;const f=fixture({memory:async()=>{calls++;throw new Error('offline fixture');}});await tick();assert(f.text().includes('offline fixture'));
  const retry=f.buttons().find(button=>button.textContent==='Retry');assert(retry&&!retry.disabled);f.rail.refresh();assert.equal(calls,1);retry.fire('click');await tick();assert.equal(calls,2);
});

test('Colab model size reflects 9B and switches back to the default Kaggle 27B',()=>{const f=fixture();f.status.status={server:'ready',host:'colab',num_ctx:32768,model_size:'9B',quant:'Q6_K'};f.rail.refresh();assert(f.text().includes('9B Qwen'));assert(!f.text().includes('27B Qwen'));f.status.status={server:'ready',host:'kaggle',num_ctx:98304,quant:'Q5_K_P'};f.rail.refresh();assert(f.text().includes('27B Qwen'));});
