// A local helper owns file access. The Worker only runs the existing hosted Qwen.
import { hasRelayKey } from './auth.js';
import { settings } from './config.js';
import { HttpError, readJsonObject } from './http.js';
import { GenerationLock } from './lock.js';
import { readTarget, serverInfo } from './target.js';
import { picturesHaveGpu, readMode } from './images.js';
import { streamChat, streamTiming } from './chat-stream.js';

export const ACTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    action: {type:'string',enum:['list','read','search','write','terminal','answer','browser_open','browser_read','browser_click','browser_type','browser_screenshot']},
    path:{type:'string'},content:{type:'string'},command:{type:'string'},query:{type:'string'},message:{type:'string'},offset:{type:'integer',minimum:0},
  }, required:['action','message','path','content','command','query','offset'],
};

export function parseAgentMessages(body, maxChars) {
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) throw new HttpError(400,'agent_input','Expected 1–100 messages.');
  const messages = body.messages.map(m => {
    if (!m || !['system','user','assistant'].includes(m.role) || typeof m.content !== 'string') throw new HttpError(400,'agent_input','Invalid agent message.');
    return {role:m.role,content:m.content};
  });
  if (messages.reduce((n,m)=>n+m.content.length,0)>maxChars) throw new HttpError(413,'agent_context','Local agent context is full. Start a new task with a concise handoff.');
  return messages;
}

export async function agentStep({env,request,ctx}) {
  if(env.AGENT_SESSION!==true)throw new HttpError(403,'own_kaggle_required','Update the local coding helper and connect your own Kaggle account. Automatic use of the website owner’s GPU is disabled for coding helpers.');
  const config = settings(env);
  // Local coding inference requires the relay credential even on an open chat website.
  if (!(await hasRelayKey(request,config.relayKey))) throw new HttpError(401,'unauthorized','A local helper relay key is required.');
  const registered = await readTarget(env.DB);
  if (!registered) throw new HttpError(503,'offline','Start the Qwen server from the website first.');
  if (picturesHaveGpu(await readMode(env.DB,registered))) throw new HttpError(409,'image_mode','Switch the server to chat before using the local agent.');
  const {numCtx,numBatch,inferenceTransport} = serverInfo(env,registered);
  const messages = parseAgentMessages(await readJsonObject(request,2*1024*1024), Math.min(220000,Math.max(4000,(numCtx-10000)*2)));
  const acquired = await GenerationLock.acquire(env.DB,'local-agent',{operation:'local_agent'});
  if (acquired.busy) throw new HttpError(409,'busy','Qwen is already working. Wait for the current operation.');
  const {lock}=acquired;
  const abort = new AbortController();
  const {readable,writable}=new TransformStream();
  const writer=writable.getWriter();
  const encode=new TextEncoder();
  const send=value=>writer.write(encode.encode(JSON.stringify(value)+'\n'));
  const disconnect=()=>abort.abort(new Error('Local helper disconnected.'));
  request.signal.addEventListener('abort',disconnect,{once:true});
  if(request.signal.aborted) disconnect();
  lock.startHeartbeat(); lock.watchForStop(disconnect);
  ctx.waitUntil((async()=>{
    try {
      let result='',complete=false;
      for await(const chunk of streamChat({target:registered.target,inferenceTransport,
        reloadTarget:async()=>(await readTarget(env.DB))?.target,
        signal:abort.signal,timing:streamTiming(config.timingScale),
        onStatus:status=>send({event:'status',...status}),
        body:{model:config.model,messages,think:false,stream:true,format:ACTION_SCHEMA,truncate:false,shift:false,keep_alive:-1,
          options:{num_ctx:numCtx,num_batch:numBatch,num_predict:8192,temperature:0.1}},
      })) {
        if(chunk.message?.content) {result+=chunk.message.content;await send({event:'content',text:chunk.message.content});}
        if(result.length>300000) throw new Error('Qwen action is too large. Ask for a smaller edit.');
        if(chunk.done) { if(chunk.done_reason==='length') throw new Error('Qwen action was cut off. Ask for a smaller edit.');complete=true; }
      }
      if(!complete) throw new Error('Qwen did not finish its action.');
      const action=JSON.parse(result);
      // The helper may request the next action immediately after receiving done.
      // Release first so it cannot race this completed step's lock cleanup.
      await lock.release();
      await send({event:'done',action});
    } catch(error) {
      if(!abort.signal.aborted) await send({event:'error',message:error.message}).catch(()=>{});
    } finally {
      request.signal.removeEventListener('abort',disconnect);
      await lock.release(); await writer.close().catch(()=>{});
    }
  })());
  return new Response(readable,{headers:{'content-type':'application/x-ndjson','cache-control':'no-store'}});
}
