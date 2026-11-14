// OpenCode owns tools, permissions and transcript/compaction. This private adapter
// only translates Chat Completions to the authenticated personal notebook's chat job.
import { HttpError, errorJson, json, readJsonObject } from './http.js';
import { GenerationLock } from './lock.js';
import { readTarget } from './target.js';
import { JobsTransportError, createJobBudget, streamJobRecords } from './jobs-transport.js';
import { sleep } from './util.js';

export const OPENCODE_MODEL='qwen3.8-hauhau';
export const OPENCODE_CONTEXT=98304;
// One reply holds its reasoning and its tool call. At 8,192 a long write was cut off
// mid-arguments after the reasoning had used most of the room.
export const OPENCODE_OUTPUT=16384;
const TOOL_RETRIES=2;
const TOOL_GUIDANCE='Keep every tool call small enough to finish: put at most about 150 lines of text in one write or edit call, and build a longer file with several calls.';
const TOOL_RETRY_CODES=new Set(['model_tool_parse_error','incomplete_tool_call','unfinished_tool_call']);
function withToolGuidance(messages){
  const at=messages.findIndex(message=>message.role==='system');
  if(at<0)return [{role:'system',content:TOOL_GUIDANCE},...messages];
  return messages.map((message,index)=>index===at?{...message,content:message.content+'\n\n'+TOOL_GUIDANCE}:message);
}
export const OPENCODE_REQUEST_MS=2*60*60_000;
export const OPENCODE_JOB_LEG_SECONDS=300;
const MAX_BODY=2*1024*1024, MAX_OUTPUT=1024*1024, MAX_CALLS=128;
// Even the shortest valid message occupies more than 16 JSON bytes. This
// defensive parser bound cannot reject a real request below the 2 MiB wire
// limit; token usage, not the number of small tool rounds, drives compaction.
const MAX_MESSAGES=Math.floor(MAX_BODY/16);
const NAME=/^[A-Za-z0-9_-]{1,64}$/, CALL_ID=/^[A-Za-z0-9_.:-]{1,200}$/;
const validName=value=>typeof value==='string'&&NAME.test(value);
const validCallId=value=>typeof value==='string'&&CALL_ID.test(value);
const encoder=new TextEncoder();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=message=>new HttpError(400,'invalid_request_error',message);
// A spent request budget is terminal. OpenCode retries HTTP 504 automatically,
// which would restart a nonstream title/summary with a fresh two-hour budget.
const requestTimeout=()=>new HttpError(400,'model_timeout','Your personal Qwen request reached the two-hour time limit.');

function textContent(content,optional=false){
  if(content==null&&optional)return '';
  if(typeof content==='string')return content;
  if(Array.isArray(content)&&content.length<=1024&&content.every(part=>object(part)&&part.type==='text'&&typeof part.text==='string'))return content.map(part=>part.text).join('');
  throw invalid('This personal coding model accepts text message content only.');
}
function argumentsObject(value){
  if(typeof value!=='string'||value.length>256*1024)throw invalid('Tool arguments must be a bounded JSON object string.');
  let parsed;try{parsed=JSON.parse(value);}catch{throw invalid('Tool arguments must contain valid JSON.');}
  if(!object(parsed))throw invalid('Tool arguments must contain a JSON object.');
  return parsed;
}
function numberOption(body,key,min,max,target=key,integer=false){
  if(body[key]===undefined)return {};
  if(typeof body[key]!=='number'||!Number.isFinite(body[key])||body[key]<min||body[key]>max||(integer&&!Number.isSafeInteger(body[key])))throw invalid('Invalid '+key+'.');
  return {[target]:body[key]};
}
// OpenCode hands its summary step the thinking mode of the turn it follows, and that
// mode outranks the summary agent's own "no thinking" setting. Notes written after a
// long think run out of reply room and the task starts over, so a summary never thinks.
const SUMMARY_PROMPT='Summarize this coding session for continuation';
function thinkingEffort(body){
  const effort=body.reasoning_effort??'medium';
  if(effort==='none')return false;
  if(effort==='minimal'||effort==='low')return 'low';
  if(effort==='medium')return 'medium';
  if(['high','xhigh','max'].includes(effort))return true;
  throw invalid('reasoning_effort must be none, minimal, low, medium, high, xhigh or max.');
}

/** Strict, bounded conversion. No arbitrary caller option/path reaches Ollama. */
export function parseOpenCodeRequest(body){
  if(body.model!==OPENCODE_MODEL)throw new HttpError(404,'model_not_found','Only '+OPENCODE_MODEL+' is available in this personal session.');
  if(body.stream!==undefined&&typeof body.stream!=='boolean')throw invalid('stream must be a boolean.');
  if(body.n!==undefined&&body.n!==1)throw invalid('Only one completion is supported.');
  if(body.response_format!==undefined&&body.response_format?.type!=='text')throw invalid('Structured response formats are unsupported; use native function tools.');
  if(body.tool_choice!==undefined&&!['auto','none'].includes(body.tool_choice))throw invalid('Only auto and none tool_choice are supported by this model transport.');
  if(body.parallel_tool_calls!==undefined&&typeof body.parallel_tool_calls!=='boolean')throw invalid('parallel_tool_calls must be a boolean.');
  if(body.stream_options!==undefined&&(!object(body.stream_options)||(body.stream_options.include_usage!==undefined&&typeof body.stream_options.include_usage!=='boolean')))throw invalid('Invalid stream_options.');
  if(body.max_tokens!==undefined&&body.max_completion_tokens!==undefined&&body.max_tokens!==body.max_completion_tokens)throw invalid('Conflicting output token limits.');
  const think=thinkingEffort(body);
  const output=body.max_completion_tokens??body.max_tokens??OPENCODE_OUTPUT;
  if(!Number.isInteger(output)||output<1||output>OPENCODE_OUTPUT)throw invalid('The output token limit must be between 1 and '+OPENCODE_OUTPUT+'.');
  let tools=[];
  if(body.tools!==undefined){
    if(!Array.isArray(body.tools)||body.tools.length>MAX_CALLS)throw invalid('Expected at most 128 function tools.');
    const names=new Set();
    tools=body.tools.map(tool=>{
      const fn=tool?.function;
      if(tool?.type!=='function'||!object(fn)||!validName(fn.name)||names.has(fn.name)||!object(fn.parameters)||(fn.description!==undefined&&typeof fn.description!=='string'))throw invalid('Invalid or duplicate function tool.');
      names.add(fn.name);
      return {type:'function',function:{name:fn.name,...(fn.description!==undefined?{description:fn.description}:{}),parameters:fn.parameters}};
    });
  }
  if(!Array.isArray(body.messages)||!body.messages.length||body.messages.length>MAX_MESSAGES)throw invalid('Expected a non-empty message array within the request-size limit.');
  const pending=new Map(),ids=new Set();
  // Only the newest assistant step keeps its reasoning in full. Replaying every earlier
  // step's complete reasoning filled the window within a few tool rounds, forcing a
  // compaction that made the task start over. Older steps keep their conclusion (the tail).
  const newestReasoned=body.messages.findLastIndex(message=>object(message)&&message.role==='assistant'&&typeof message.reasoning_content==='string'&&message.reasoning_content);
  const messages=body.messages.map((message,position)=>{
    if(!object(message)||!['system','developer','user','assistant','tool'].includes(message.role))throw invalid('Invalid message role.');
    const role=message.role==='developer'?'system':message.role;
    const reasoning=message.reasoning_content;
    if(reasoning!==undefined&&reasoning!==null&&(role!=='assistant'||typeof reasoning!=='string'))throw invalid('Only assistant messages may contain text reasoning_content.');
    const content=textContent(message.content,role==='assistant'&&(message.tool_calls?.length>0||typeof reasoning==='string'));
    if(role==='tool'){
      const name=pending.get(message.tool_call_id);
      if(!name)throw invalid('A tool result must refer to a preceding unresolved tool call.');
      pending.delete(message.tool_call_id);
      return {role,tool_call_id:message.tool_call_id,tool_name:name,content};
    }
    if(pending.size)throw invalid('Complete preceding tool results before another message.');
    if(message.tool_calls!==undefined&&role!=='assistant')throw invalid('Only assistant messages can contain tool calls.');
    let calls;
    if(message.tool_calls!==undefined){
      if(!Array.isArray(message.tool_calls)||!message.tool_calls.length||message.tool_calls.length>MAX_CALLS)throw invalid('Invalid assistant tool calls.');
      calls=message.tool_calls.map((call,index)=>{
        if(call?.type!=='function'||!validCallId(call.id)||ids.has(call.id)||!validName(call.function?.name))throw invalid('Invalid or duplicate assistant tool call identity.');
        ids.add(call.id);pending.set(call.id,call.function.name);
        return {id:call.id,type:'function',function:{index,name:call.function.name,arguments:argumentsObject(call.function.arguments)}};
      });
    }
    // Native llama-server conversion drops Message.Thinking on every tool round,
    // not just the finishing call. Keep the plan in normal model-visible content
    // so a tool result does not make the next generation start from scratch.
    return {role,content:typeof reasoning==='string'&&reasoning?workingCheckpoint({reasoning:position===newestReasoned?reasoning:trimmedReasoning(reasoning),content},true).content:content,...(calls?{tool_calls:calls}:{})};
  });
  if(pending.size)throw invalid('Tool calls require their results before requesting another completion.');
  const options={num_ctx:OPENCODE_CONTEXT,num_batch:256,num_predict:output,
    ...numberOption(body,'temperature',0,2),...numberOption(body,'top_p',0,1),
    ...numberOption(body,'frequency_penalty',-2,2),...numberOption(body,'presence_penalty',-2,2),
    ...numberOption(body,'seed',-2147483648,2147483647,'seed',true)};
  if(body.stop!==undefined){
    const stop=typeof body.stop==='string'?[body.stop]:body.stop;
    if(!Array.isArray(stop)||stop.length>4||stop.some(s=>typeof s!=='string'||s.length>1024))throw invalid('Expected at most four bounded stop strings.');
    options.stop=stop;
  }
  // readJsonObject bounds the complete request to 2 MiB. OpenCode budgets its
  // own transcript using measured token usage; a character heuristic here would
  // disagree with its compactor. The notebook rejects actual tokenizer overflow
  // with truncate/shift disabled, and never silently removes message history.
  if(body.tool_choice==='none')tools=[];
  const summary=!tools.length&&messages.some(message=>message.role==='system'&&typeof message.content==='string'&&message.content.includes(SUMMARY_PROMPT));
  return {stream:body.stream===true,includeUsage:body.stream_options?.include_usage===true,parallel:body.parallel_tool_calls!==false,
    tools,body:{model:OPENCODE_MODEL,messages,...(tools.length?{tools}:{}),think:summary?false:think,stream:true,truncate:false,shift:false,keep_alive:-1,options}};
}

export function openCodeModels(){
  return json({object:'list',data:[{id:OPENCODE_MODEL,object:'model',created:0,owned_by:'personal-kaggle'}]});
}

// SSE comments are ignored by standard parsers. Padding every two seconds keeps
// tiny tokens moving through compression/buffering intermediaries, even after prefill.
export class OpenCodeEventWriter {
  #writer;#onGone;#encoder=new TextEncoder();#tail=Promise.resolve();#pending=0;#timer;#timeout;
  gone=false;
  constructor(writable,onGone,{heartbeatMs=2000,writeTimeoutMs=10000}={}){
    this.#writer=writable.getWriter();this.#onGone=onGone;this.#timeout=writeTimeoutMs;
    this.#writer.closed.catch(()=>this.markGone());
    this.#timer=setInterval(()=>{if(!this.gone&&!this.#pending)void this.#write(':'+ ' '.repeat(16380)+'\n\n');},heartbeatMs);
  }
  async #write(value){
    if(this.gone)return;
    this.#pending++;
    const run=async()=>{
      if(this.gone)return;
      let timer;
      try{await Promise.race([this.#writer.write(this.#encoder.encode(value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Client stopped reading.')),this.#timeout);})]);}
      catch{this.markGone();}finally{clearTimeout(timer);}
    };
    const write=this.#tail.then(run,run);this.#tail=write;
    try{await write;}finally{this.#pending--;}
  }
  send(value){return this.#write('data: '+JSON.stringify(value)+'\n\n');}
  async done(){clearInterval(this.#timer);await this.#write('data: [DONE]\n\n');}
  markGone(){if(this.gone)return;this.gone=true;clearInterval(this.#timer);this.#onGone();void this.#writer.abort().catch(()=>{});}
  async close(){
    clearInterval(this.#timer);await this.#tail;
    let timer;try{await Promise.race([this.gone?this.#writer.abort():this.#writer.close(),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}catch{}finally{clearTimeout(timer);}
  }
}

function modelFailure(error,upstream=false){
  if(error instanceof HttpError)return error;
  const fromModel=upstream||(error instanceof JobsTransportError&&error.upstreamStatus>=400);
  let detail=String(error?.message||'');
  // Ollama errors can be strings or nested objects. Inspect them for a fixed
  // reason code, never echo raw errors: tool parsers may include private args.
  if(fromModel){try{const parsed=JSON.parse(detail);detail=typeof parsed.error==='string'?parsed.error:parsed.error?.message||parsed.message||detail;}catch{}}
  if(fromModel&&/out of memory|cudaMalloc|(?:allocat|insufficient|requires more).*(?:memory|buffer)/i.test(detail))return new HttpError(502,'model_out_of_memory','The model reported insufficient memory. Your notebook may still be online. Restart it or select a model that fits its GPU; repeated retries will not fix a memory limit.');
  if(fromModel&&/invalid tool call arguments|error parsing tool call|failed to parse.*tool|tool.*(?:invalid JSON|JSON.*(?:invalid|parse))/i.test(detail))return new HttpError(502,'model_tool_parse_error','The model produced malformed tool arguments. No tools from this failed response were released.');
  if(fromModel&&/model runner.*(?:stopp|terminat)|runner process.*(?:terminat|exit)|llama runner.*(?:stopp|terminat)|error was encountered while running the model/i.test(detail))return new HttpError(502,'model_runner_stopped','The model runner stopped during this response. The notebook may still be online.');
  if(fromModel&&/context (?:length|window|size)|(?:input|prompt).*too (?:large|long)|(?:input|prompt).*longer than.*context|exceed.*(?:context|token|window)/i.test(detail))return new HttpError(413,'context_length_exceeded','The model tokenizer could not fit this input. Compact the OpenCode session.');
  if(fromModel)return new HttpError(502,'model_upstream_error','Ollama rejected or failed this response. The notebook may still be online; check its Ollama runtime log for the underlying error.');
  if(error instanceof JobsTransportError)return new HttpError(error.code==='payload_limit'?400:502,error.code,error.message);
  return new HttpError(502,'model_error','The coding connector could not complete this response. The notebook may still be online.');
}

function modelRecordError(value){return new Error(typeof value==='string'?value:JSON.stringify(value??'Model HTTP error.'));}

function workingCheckpoint(result,historical=false){
  // Native Ollama llama-server chat conversion omits Message.Thinking. Normal
  // content survives that conversion and the model's Jinja template. These are
  // unverified notes, not tool results or permission to execute an earlier call.
  const prefix=historical?'Saved working notes for this earlier assistant message. Plans and guesses are unverified; native tool calls and subsequent actual tool results establish what ran. Notes alone are not proof of execution.':'Unfinished working notes from this response. Plans and guesses below are unverified; only actual tool results in the preceding conversation establish completed actions. No tool call from these notes has been released.';
  // Plain text with real line breaks. As one-line JSON the model saw every earlier
  // answer with its newlines escaped, and began writing its own answers the same way.
  return {role:'assistant',content:prefix+'\n[notes]\n'+(result.reasoning||'')+'\n[/notes]'+(result.content?'\n'+result.content:'')};
}

export const HISTORY_REASONING_CHARS=1200;
function trimmedReasoning(reasoning){
  if(reasoning.length<=HISTORY_REASONING_CHARS)return reasoning;
  // The plan and exact identifiers open a step's reasoning; its conclusion closes it.
  let head=HISTORY_REASONING_CHARS/2,start=reasoning.length-HISTORY_REASONING_CHARS/2;
  if(/[\uD800-\uDBFF]/.test(reasoning[head-1]))head--;
  if(/[\uDC00-\uDFFF]/.test(reasoning[start]))start++;
  return reasoning.slice(0,head)+' [middle of this earlier reasoning trimmed] '+reasoning.slice(start);
}

const TOOL_LOOP_REPEATS=3,TOOL_LOOP_PERIOD=8;
const canonicalJson=value=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function toolActions(calls){
  return canonicalJson(calls.map(call=>{
    const fn=call.function,args=typeof fn.arguments==='string'?argumentsObject(fn.arguments):fn.arguments;
    // Native bash's description only labels the UI. Renaming that label does
    // not turn the same command into progress; other execution options count.
    const parameters=fn.name==='bash'?Object.fromEntries(Object.entries(args).filter(([key])=>key!=='description')):args;
    return {name:fn.name,arguments:parameters};
  }));
}

/** Stop unchanged tool cycles across assistant messages, before releasing tools. */
export function assertOpenCodeToolProgress(messages,calls){
  if(!calls.length)return;
  // A real new user instruction permits an intentional retry. Assistant prose,
  // reasoning and changing generated call IDs cannot reset the progress guard.
  const start=messages.findLastIndex(message=>message.role==='user')+1;
  const rounds=[];let pending=null;
  for(let index=start;index<messages.length;index++){
    const message=messages[index];
    if(message.role==='assistant'&&message.tool_calls?.length)pending={calls:message.tool_calls,results:new Map()};
    else if(message.role==='tool'&&pending){
      pending.results.set(message.tool_call_id,message.content);
      if(pending.results.size===pending.calls.length){
        const actions=toolActions(pending.calls);
        rounds.push({actions,signature:canonicalJson([actions,pending.calls.map(call=>pending.results.get(call.id))])});
        if(rounds.length>TOOL_LOOP_REPEATS*TOOL_LOOP_PERIOD)rounds.shift();
        pending=null;
      }
    }
  }
  const proposed=toolActions(calls);
  for(let period=1;period<=TOOL_LOOP_PERIOD&&period*TOOL_LOOP_REPEATS<=rounds.length;period++){
    const offset=rounds.length-period*TOOL_LOOP_REPEATS;
    if(proposed!==rounds[offset].actions)continue;
    if(rounds.slice(offset+period).every((round,index)=>round.signature===rounds[offset+index%period].signature)){
      throw new HttpError(400,'tool_progress_stalled','Qwen requested the same tool cycle again after three unchanged results. No tools from this response were released. Review the completed tool results and give a new instruction to continue.');
    }
  }
}

// Metadata and summary calls must not erase a failing main turn's streak. This
// state is personal-session scoped and is read/written only under GenerationLock.
const OVERFLOW_KEY='opencode_overflow';
async function recordOverflow(db){
  const row=await db.prepare('SELECT v FROM state WHERE k = ?1').bind(OVERFLOW_KEY).first();
  let saved;try{saved=row?JSON.parse(row.v):null;}catch{}
  const age=Date.now()-saved?.at;
  const previous=Number.isInteger(saved?.count)&&saved.count>0&&Number.isFinite(age)&&age>=0&&age<OPENCODE_REQUEST_MS?saved.count:0;
  const count=Math.min(previous+1,3),at=Date.now();
  await db.prepare('INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(OVERFLOW_KEY,JSON.stringify({count,at}),new Date(at).toISOString()).run();
  return count;
}
async function clearOverflow(db){await db.prepare('DELETE FROM state WHERE k = ?1').bind(OVERFLOW_KEY).run();}

function requireProfile(target,profile){
  if(!target)throw new HttpError(503,'offline','Your personal Kaggle notebook is not connected yet.');
  const matches=profile?target.quant===profile.quant&&[32768,24576,16384,8192].includes(target.num_ctx)&&target.num_ctx<=profile.context&&target.num_batch===128&&target.profile_id===profile.profile_id:target.quant==='Q5_K_P'&&target.num_ctx===OPENCODE_CONTEXT&&target.num_batch===256;
  if(!matches||target.host!=='kaggle'||target.vision===true||target.inference_transport!=='jobs-v1')throw new HttpError(409,'personal_profile','This session requires its Q5_K_P / 96K / batch256 chat-only notebook.');
  if(target.job_max_leg_seconds<OPENCODE_JOB_LEG_SECONDS||!Number.isInteger(target.job_max_leg_seconds)||target.job_control!==true)throw new HttpError(409,'personal_profile','Restart your personal Kaggle notebook using the updated connector to enable two-hour requests.');
  return target.target;
}

/** Wait on the notebook rather than spending D1 queries every few seconds. */
export async function waitOpenCodeIdle({target,controlKey,signal,deadline,requestBudget,fetchImpl=fetch}){
  if(!/^[a-f0-9]{64}$/.test(controlKey||''))throw new HttpError(409,'personal_profile','Restart the updated connector to enable personal job control.');
  const budget=requestBudget??createJobBudget(40);let failures=0;
  for(;;){
    signal.throwIfAborted();
    const remaining=deadline-Date.now();if(remaining<=0)throw requestTimeout();
    // Leave space for both bounded model jobs and their cancellation requests.
    if(budget.used>=budget.limit-6)throw new HttpError(503,'queue_connection_limit','The personal model queue used its connection allowance. Retry when the current task finishes.');
    const seconds=Math.min(OPENCODE_JOB_LEG_SECONDS,remaining/1000);
    budget.used++;const headers=new AbortController();const timer=setTimeout(()=>headers.abort(),Math.min(30000,remaining));
    let reader;
    try{
      const timeout=Math.max(1,Math.ceil(Math.min(remaining,seconds*1000+30000)));
      const response=await fetchImpl(target+'/_jobs/control?max_seconds='+seconds,{redirect:'manual',headers:{authorization:'Bearer '+controlKey},signal:AbortSignal.any([signal,headers.signal,AbortSignal.timeout(timeout)])});
      clearTimeout(timer);
      if(!response.ok){await response.body?.cancel();throw new Error('The personal queue did not acknowledge its control request.');}
      if(!response.body)throw new Error('The personal queue returned no control stream.');
      reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',bytes=0,records=0,last;
      for(;;){
        signal.throwIfAborted();let idleTimer;
        const next=await Promise.race([reader.read(),new Promise((_,reject)=>{idleTimer=setTimeout(()=>reject(new Error('The personal queue stopped reporting status.')),30000);})]).finally(()=>clearTimeout(idleTimer));
        if(next.done){pending+=decoder.decode();if(pending.trim())throw new Error('The personal queue ended a partial status record.');break;}
        bytes+=next.value.byteLength;if(bytes>4*1024*1024)throw new Error('The personal queue returned excessive status data.');
        pending+=decoder.decode(next.value,{stream:true});let end;
        while((end=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,end);pending=pending.slice(end+1);if(line.length>65536||++records>1024)throw new Error('The personal queue returned excessive status records.');
          const value=JSON.parse(line);if(!object(value)||typeof value.busy!=='boolean'||Object.keys(value).some(key=>key!=='busy'))throw new Error('The personal queue returned invalid status.');
          last=value.busy;if(!last)return;
        }
        if(pending.length>65536)throw new Error('The personal queue returned an oversized status record.');
      }
      if(last!==true)throw new Error('The personal queue returned no status.');
      failures=0;
    }catch(error){
      signal.throwIfAborted();if(Date.now()>=deadline)throw requestTimeout();
      if(++failures>=3)throw new HttpError(502,'queue_unreachable','The personal model queue could not be reached reliably. Check your Kaggle notebook and retry.');
      await sleep(1000,signal);
    }finally{clearTimeout(timer);await reader?.cancel().catch(()=>{});reader?.releaseLock();}
  }
}

/** Native Ollama tool objects become OpenAI name/id/argument deltas, never an action schema. */
class Completion {
  content='';reasoning='';calls=[];size=0;done=false;finish='stop';usage=null;measured=false;
  #names;#parallel;#indices=new Map();
  constructor(tools,parallel){this.#names=new Set(tools.map(t=>t.function.name));this.#parallel=parallel;}
  addSize(value){this.size+=encoder.encode(value).length;if(this.size>MAX_OUTPUT)throw new HttpError(502,'output_limit','The personal model response exceeded its output limit.');}
  consume(raw){
    if(raw.model!==undefined&&raw.model!==OPENCODE_MODEL&&raw.model!==OPENCODE_MODEL+':latest')throw new HttpError(502,'model_mismatch','The notebook returned an unexpected model.');
    if(raw.error)throw modelFailure(modelRecordError(raw.error),true);
    const deltas=[],message=raw.message;
    if(message!==undefined&&!object(message))throw new HttpError(502,'invalid_model_response','The model returned an invalid message.');
    if(message?.content!==undefined&&typeof message.content!=='string')throw new HttpError(502,'invalid_model_response','The model returned invalid text.');
    if(message?.thinking!==undefined&&typeof message.thinking!=='string')throw new HttpError(502,'invalid_model_response','The model returned invalid reasoning.');
    // Keep reasoning in its own OpenAI-compatible channel. It must never become
    // answer text or executable tool arguments, including while tools are pending.
    if(message?.thinking){this.addSize(message.thinking);this.reasoning+=message.thinking;deltas.push({reasoning_content:message.thinking});}
    if(message?.content){this.addSize(message.content);this.content+=message.content;deltas.push({content:message.content});}
    if(message?.tool_calls!==undefined){
      if(!Array.isArray(message.tool_calls)||message.tool_calls.length>MAX_CALLS)throw new HttpError(502,'invalid_tool_call','The model returned invalid tool calls.');
      for(const call of message.tool_calls){
        const fn=call?.function,index=fn?.index??call?.index;
        if(!object(fn)||(index!==undefined&&(!Number.isInteger(index)||index<0||index>=MAX_CALLS)))throw new HttpError(502,'invalid_tool_call','The model returned an invalid tool call.');
        let existing=index===undefined?undefined:this.#indices.get(index);
        if(existing===undefined){
          if(this.calls.length>=MAX_CALLS||(!this.#parallel&&this.calls.length)||!this.#names.has(fn.name))throw new HttpError(502,'invalid_tool_call','The model requested an unavailable or unsupported tool.');
          existing=this.calls.length;
          this.calls.push({id:'call_'+crypto.randomUUID().replaceAll('-',''),type:'function',function:{name:fn.name,arguments:''}});
          if(index!==undefined)this.#indices.set(index,existing);
        }
        const saved=this.calls[existing];
        if(fn.name!==undefined&&fn.name!==saved.function.name)throw new HttpError(502,'invalid_tool_call','The model changed a tool call identity.');
        let args='';
        if(typeof fn.arguments==='string')args=fn.arguments;
        else if(object(fn.arguments)){if(saved.function.arguments)throw new HttpError(502,'invalid_tool_call','The model repeated tool arguments.');args=JSON.stringify(fn.arguments);}
        else if(fn.arguments!==undefined)throw new HttpError(502,'invalid_tool_call','The model returned invalid tool arguments.');
        this.addSize(args);saved.function.arguments+=args;
        // Hold tool calls until terminal success. Some clients execute as soon
        // as JSON becomes parseable, before a later upstream error can arrive.
      }
    }
    if(raw.done===true){
      if(raw.done_reason==='length'&&this.calls.length)throw new HttpError(502,'incomplete_tool_call','The model tool response reached its output limit. No complete tool response was produced.');
      for(const call of this.calls){try{if(!object(JSON.parse(call.function.arguments)))throw new Error();}catch{throw new HttpError(502,'unfinished_tool_call','The model did not finish valid JSON tool arguments.');}}
      this.done=true;this.finish=raw.done_reason==='length'?'length':this.calls.length?'tool_calls':'stop';
      const input=Number.isSafeInteger(raw.prompt_eval_count)&&raw.prompt_eval_count>=0?raw.prompt_eval_count:0;
      const output=Number.isSafeInteger(raw.eval_count)&&raw.eval_count>=0?raw.eval_count:0;
      this.measured=Number.isSafeInteger(raw.prompt_eval_count)&&input>0&&Number.isSafeInteger(raw.eval_count)&&output>0;
      this.usage={prompt_tokens:input,completion_tokens:output,total_tokens:input+output};
      for(let index=0;index<this.calls.length;index++){
        const call=this.calls[index];
        deltas.push({tool_calls:[{index,id:call.id,type:'function',function:{name:call.function.name,arguments:''}}]});
        deltas.push({tool_calls:[{index,function:{arguments:call.function.arguments}}]});
      }
    }
    return deltas;
  }
  message(){return {role:'assistant',content:this.content||null,...(this.reasoning?{reasoning_content:this.reasoning}:{}),...(this.calls.length?{tool_calls:this.calls}:{})};}
}

export async function openCodeChat({request,env,ctx,ensureActive=async()=>{}}){
  if(env.AGENT_SESSION!==true)throw new HttpError(403,'own_kaggle_required','Connect your own personal Kaggle session to use OpenCode.');
  let body;
  try{body=await readJsonObject(request,MAX_BODY);}
  catch(error){
    // Native OpenCode compacts every HTTP413. This transport byte cap cannot
    // be fixed by repeatedly summarizing and replaying the same oversized turn.
    if(error instanceof HttpError&&error.status===413)throw new HttpError(400,'relay_body_limit','The relay accepts request bodies up to 2 MiB. Split the latest prompt or tool output before retrying.');
    throw error;
  }
  const parsed=parseOpenCodeRequest(body);
  if(parsed.tools.length)parsed.body.messages=withToolGuidance(parsed.body.messages);
  const mainRequest=parsed.tools.length>0||parsed.body.think!==false;
  const selected=env.AGENT_MODEL_PROFILE;
  const configurePayload=registered=>{if(!selected)return;requireProfile(registered,selected);parsed.body.options.num_ctx=registered.num_ctx;parsed.body.options.num_batch=128;parsed.body.options.num_predict=Math.min(parsed.body.options.num_predict,Math.max(1024,Math.min(4096,Math.floor(registered.num_ctx/4))));if(registered.thinking!==true)delete parsed.body.think;};
  let registered=await readTarget(env.DB),target=requireProfile(registered,selected);configurePayload(registered);
  if(!/^[a-f0-9]{64}$/.test(env.AGENT_CONTROL_KEY||''))throw new HttpError(409,'personal_profile','Restart the updated connector to enable personal job control.');
  const abort=new AbortController();let events,lock;
  const disconnect=()=>abort.abort(new HttpError(499,'cancelled','The OpenCode request was cancelled.'));
  request.signal.addEventListener('abort',disconnect,{once:true});if(request.signal.aborted)disconnect();
  const id='chatcmpl-'+crypto.randomUUID().replaceAll('-',''),created=Math.floor(Date.now()/1000);
  const chunk=(delta,finish=null)=>({id,object:'chat.completion.chunk',created,model:OPENCODE_MODEL,choices:[{index:0,delta,finish_reason:finish}]});
  let result=new Completion(parsed.tools,parsed.parallel);
  const main=mainRequest;
  const run=async()=>{
    const deadline=Date.now()+OPENCODE_REQUEST_MS;
    const requestTimer=setTimeout(()=>abort.abort(requestTimeout()),OPENCODE_REQUEST_MS);
    const requestBudget=createJobBudget(40);
    let modelStarted=false,acquisitions=0;
    try{
      if(events)await events.send(chunk({role:'assistant',content:''}));
      // OpenCode forks title generation beside its first main request, and can
      // run subagents concurrently. Serialize their inference while keeping the
      // waiting response alive; a busy rejection would fail the user's turn.
      const acquire=async()=>{while(!lock){
        abort.signal.throwIfAborted();
        if(++acquisitions>6)throw new HttpError(503,'queue_busy','The personal model queue stayed busy. Retry when the current task finishes.');
        const acquired=await GenerationLock.acquire(env.DB,'opencode',{operation:'opencode'});
        if(acquired.lock)lock=acquired.lock;
        else{
          await waitOpenCodeIdle({target,controlKey:env.AGENT_CONTROL_KEY,signal:abort.signal,deadline,requestBudget});
          await sleep(1000,abort.signal);
        }
      }};
      await acquire();
      // The queue and generation share one two-hour deadline. Longer, padded
      // job legs stay below the free Worker's external-request allowance.
      // Independent authenticated notebook-command requests renew this lease
      // and cancel matching jobs. Long invocations keep no D1 polling timers.
      // A queued request must not revive a session that expired or was stopped.
      await ensureActive();abort.signal.throwIfAborted();
      registered=await readTarget(env.DB);target=requireProfile(registered,selected);configurePayload(registered);
      modelStarted=true;
      let payload=parsed.body,targetReloads=0,finished=false,recovered=false,toolRetries=0,completedOutput=0,completedReasoning=0;
      const reloadTarget=async()=>{if(targetReloads++<3)target=requireProfile(await readTarget(env.DB),env.AGENT_MODEL_PROFILE);return target;};
      for(let pass=0;pass<5;pass++){
        abort.signal.throwIfAborted();
        const generationContentStart=result.content.length;
        const identity={id:lock.id+(pass===0||recovered?'-main':'-finish'),token:crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','')};
        try{
        for await(const part of streamJobRecords({target,path:'/api/chat',payload:JSON.stringify(payload),signal:abort.signal,requestBudget,identity,
          legSeconds:OPENCODE_JOB_LEG_SECONDS,prefillLegSeconds:OPENCODE_JOB_LEG_SECONDS,maxJobMs:Math.max(1,deadline-Date.now()),
          reloadTarget})){
          abort.signal.throwIfAborted();
          if(part.upstreamStatus!==null&&part.upstreamStatus>=300)throw modelFailure(modelRecordError(part.value.error||'Model HTTP error.'),true);
          const deltas=result.consume(part.value);
          // OpenCode 1 checks doom_loop within one assistant message, so it
          // misses one-tool-per-step loops. Check the actual completed history
          // here, after terminal validation and before any executable delta.
          if(result.done&&result.calls.length)assertOpenCodeToolProgress(parsed.body.messages,result.calls);
          for(const delta of deltas)if(events)await events.send(chunk(delta));
          if(result.done)break;
        }
        if(!result.done)throw new HttpError(502,'incomplete_response','The personal model stream ended before completion.');
        if(!finished&&result.finish==='length'&&result.reasoning&&!result.content&&!result.calls.length){
          // One narrow finish attempt lets Qwen use its saved work instead of
          // silently ending a turn that spent its complete reply on reasoning.
          // Never replay incomplete/unknown streams, tool calls, or cancellation.
          if(!result.measured)throw new HttpError(502,'reasoning_finish_unavailable','Qwen reached its reply limit without verified token usage. Progress remains saved; retry explicitly.');
          const available=parsed.body.options.num_ctx-result.usage.prompt_tokens-result.usage.completion_tokens-2048;
          if(available<1024)throw new HttpError(413,'context_length_exceeded','The saved reasoning and the next reply cannot fit. Compact the OpenCode session.');
          completedOutput+=result.usage.completion_tokens;completedReasoning+=result.usage.completion_tokens;
          payload={...parsed.body,think:false,options:{...parsed.body.options,num_predict:Math.min(4096,available)},messages:[...parsed.body.messages,
            workingCheckpoint(result),
            {role:'user',content:'Continue the unfinished response using the saved reasoning above. Do not reason further. Give the final answer now, or request the next necessary tool using the available native tools.'},
          ]};
          const prior=result;result=new Completion(parsed.tools,parsed.parallel);result.reasoning=prior.reasoning;result.addSize(prior.reasoning);
          finished=true;
          continue;
        }
        if(finished&&!result.content.slice(generationContentStart).trim()&&!result.calls.length)throw recovered
          ?new HttpError(502,'model_recovery_incomplete','The automatic recovery produced no new answer or tool call. Partial work remains saved; retry explicitly.')
          :new HttpError(502,'reasoning_finish_incomplete','Qwen did not produce an answer or a tool call after the single finishing attempt. Progress remains saved; retry explicitly.');
        if(completedOutput){result.usage.completion_tokens+=completedOutput;result.usage.total_tokens=result.usage.prompt_tokens+result.usage.completion_tokens;result.usage.completion_tokens_details={reasoning_tokens:completedReasoning};}
        break;
        }catch(error){
          const failure=modelFailure(error);
          const toolFailure=TOOL_RETRY_CODES.has(failure.code);
          // Tool deltas are held until terminal success, so a known failed model
          // generation has executed nothing. Preserve visible text/notes and
          // continue without thinking, never an unknown replay. A stopped runner
          // gets one continuation. A cut-off or malformed tool call gets two, each
          // with the whole reply budget and a smaller piece to write: the usual
          // cause is one call carrying more text than a reply can hold.
          const spent=toolFailure?toolRetries>=TOOL_RETRIES:failure.code!=='model_runner_stopped'||recovered||result.calls.length>0;
          if(spent||abort.signal.aborted||pass>=4||acquisitions>=5||requestBudget.used>=requestBudget.limit-6){
            if(toolFailure&&toolRetries)throw new HttpError(502,failure.code,'Qwen could not finish a valid tool call after '+toolRetries+' smaller retries. Nothing from the failed calls ran. Send "continue" and ask for the file to be written in smaller parts.');
            throw failure;
          }
          recovered=true;finished=true;if(toolFailure)toolRetries++;
          const lines=toolRetries>1?60:150;
          const instruction=toolFailure
            ?'The preceding tool call was cut off or its arguments were not valid JSON, so nothing ran. The usual cause is one call carrying too much text. Continue from the notes above. Do not reason further. Make one valid native tool call now. If you were writing or replacing a long text, send only the first part in this call, at most about '+lines+' lines, and add the rest with further calls afterwards. Never assume a planned tool action has run; only preceding real tool results prove execution.'
            :'The preceding model generation failed before any tool calls were released. Continue from the unfinished notes and answer text above without repeating text already written. Do not reason further. Produce the next answer or one valid native tool call. Never assume a planned tool action has run; only preceding real tool results prove execution.';
          payload={...parsed.body,think:false,options:{...parsed.body.options,temperature:0,num_predict:toolFailure?parsed.body.options.num_predict:Math.min(4096,parsed.body.options.num_predict)},messages:[...parsed.body.messages,workingCheckpoint(result),
            {role:'user',content:instruction}]};
          if(selected&&registered.thinking!==true)delete payload.think;
          const prior=result;result=new Completion(parsed.tools,parsed.parallel);result.reasoning=prior.reasoning;result.content=prior.content;result.addSize(prior.reasoning+prior.content);
          // A fresh generation lock gives recovery its own authenticated job
          // identity while remaining compatible with existing notebook leases.
          // Queue/recovery share the original deadline and external-call budget.
          await lock.release();lock=null;await acquire();await ensureActive();abort.signal.throwIfAborted();
          registered=await readTarget(env.DB);target=requireProfile(registered,selected);configurePayload(registered);
          payload.options={...payload.options,num_ctx:parsed.body.options.num_ctx,num_batch:parsed.body.options.num_batch,num_predict:Math.min(payload.options.num_predict,parsed.body.options.num_predict)};
          if(selected&&registered.thinking!==true)delete payload.think;
        }
      }
      if(main)await clearOverflow(env.DB);
      await lock.release();
      if(events){
        await events.send(chunk({},result.finish));
        if(parsed.includeUsage)await events.send({id,object:'chat.completion.chunk',created,model:OPENCODE_MODEL,choices:[],usage:result.usage});
        await events.done();
      }else return json({id,object:'chat.completion',created,model:OPENCODE_MODEL,choices:[{index:0,message:result.message(),finish_reason:result.finish}],usage:result.usage});
    }catch(error){
      let failure=modelFailure(abort.signal.aborted?abort.signal.reason:error);
      if(main&&modelStarted&&lock&&!abort.signal.aborted&&failure.code==='context_length_exceeded'){
        try{
          if(await recordOverflow(env.DB)>=3)failure=new HttpError(400,'context_recovery_stalled','Automatic recovery did not reduce this request after two attempts. Stop automatic retries; shorten the latest prompt or start a new session. Saved history remains available.');
        }catch{failure=new HttpError(503,'recovery_state_unavailable','Automatic recovery could not be tracked safely. Retry this request.');}
      }
      if(events){if(!events.gone&&!request.signal.aborted){
        // The pinned OpenAI-compatible SDK reduces SSE errors to their message
        // string. OpenCode recognizes this structured string as an overflow and
        // invokes its own compactor; a plain sentence would lose the error code.
        const message=failure.code==='context_length_exceeded'?JSON.stringify({type:'error',error:{code:failure.code,message:failure.message}}):failure.message;
        await events.send({error:{message,type:'api_error',code:failure.code}});await events.done();
      }}
      else return errorJson(failure);
    }finally{
      clearTimeout(requestTimer);request.signal.removeEventListener('abort',disconnect);abort.abort();await lock?.release();await events?.close();
    }
  };
  if(!parsed.stream)return await run();
  const {readable,writable}=new TransformStream();events=new OpenCodeEventWriter(writable,disconnect);
  ctx.waitUntil(run());
  return new Response(readable,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store, no-transform','x-accel-buffering':'no'}});
}
