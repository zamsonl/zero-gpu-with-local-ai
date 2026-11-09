import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';

class Element {
  constructor(tag,props={}){this.tag=tag;this.children=[];this.listeners={};this.open=false;this.hidden=false;this.style={setProperty:(key,value)=>this.style[key]=value};Object.assign(this,props);this.className=props.class||'';this.classList={toggle:(key,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));on?names.add(key):names.delete(key);this.className=[...names].join(' ');}};}
  append(...items){for(const node of items){node.parent=this;this.children.push(node);}}
  replaceChildren(...items){this.children=[];this.append(...items);}
  before(node){this.previous=node;}
  addEventListener(type,listener){this.listeners[type]=listener;}
  getBoundingClientRect(){return {top:this.top??500};}
  contains(node){return this===node||this.children.some(child=>child.contains?.(node));}
  focus(){this.focused=true;}
}
const code=(await fs.readFile(new URL('../public/js/context-ui.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
function fixture(){
  const composer=new Element('form'),document={getElementById:()=>composer,listeners:{},addEventListener(type,listener){this.listeners[type]=listener;}};
  const window={listeners:{},addEventListener(type,listener){this.listeners[type]=listener;}};
  const h=(tag,props,...items)=>{const element=new Element(tag,props);if(props?.text!==undefined)element.textContent=props.text;element.append(...items);return element;};
  let compacted=0;const snapshot={chatId:'one',attachments:[],messages:[],think:true,busy:false,compacting:false};
  const status={status:{server:'ready',num_ctx:98304},addEventListener(){}};
  const ContextView=new Function('h','document','window','tokensShort','isPictureAttachment','NORMAL_PROMPT_CHARS','NORMAL_DOCUMENT_CHARS',code+'\nreturn ContextView;')(h,document,window,value=>value<1000?String(value):Math.round(value/1000)+'K',()=>false,100000,120000);
  const view=new ContextView({status,snapshot:()=>snapshot,onCompact:()=>compacted++,onContext(){}});
  view.context={capacity_tokens:98304,input_budget_tokens:72704,estimated_input_tokens:22000,reserved_reply_tokens:24576,overhead_tokens:1024,included_message_count:6,can_compact:true};view.render();
  return {view,snapshot,status,document,compacted:()=>compacted};
}
test('Compact session stays in one collapsed context disclosure and invokes its action once',()=>{
  const {view,compacted}=fixture();assert.equal(view.details.open,false);assert(view.explanation.contains(view.compact));assert(!view.el.children[0].children.includes(view.compact));assert.match(view.value.textContent,/Context.*22K.*73K input/);assert.equal(view.compact.disabled,false);
  view.compact.listeners.click();assert.equal(compacted(),1);const actions=view.compact.parent;view.render();assert.equal(view.compact.parent,actions,'Counter refresh must keep the action node in place');
});
test('context controls reflect operation and server readiness without offering an unsafe compact action',()=>{
  const {view,snapshot,status}=fixture();snapshot.busy=true;view.render();assert(view.compact.disabled);snapshot.busy=false;status.status.server='unregistered';view.render();assert(view.compact.disabled);assert.equal(view.value.textContent,'Context capacity pending');status.status.server='ready';snapshot.compacting=true;view.render();assert(view.compact.disabled);assert.equal(view.compact.textContent,'Compacting…');
});
test('context disclosure closes from Escape/outside and stays on-screen above a resized composer',()=>{
  const {view,document}=fixture();view.details.open=true;view.el.top=80;view.positionDetails();assert(view.explanation.className.includes('is-sheet'));view.el.top=400;view.positionDetails();assert(!view.explanation.className.includes('is-sheet'));assert.equal(view.explanation.style['--context-room'],'380px');
  view.details.listeners.keydown({key:'Escape',preventDefault(){}});assert.equal(view.details.open,false);assert(view.toggle.focused);view.details.open=true;document.listeners.pointerdown({target:new Element('textarea')});assert.equal(view.details.open,false);
});
test('full context explains automatic preservation while the compact button remains available in details',()=>{
  const {view}=fixture();Object.assign(view.context,{would_omit_history:true,omitted_message_count:8});view.render();assert.match(view.note.textContent,/summarized automatically/);assert.equal(view.compact.disabled,false);assert.equal(view.details.open,false);
});
