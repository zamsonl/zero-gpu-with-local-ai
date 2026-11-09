// Browser NDJSON: fixed-cadence padding prevents intermediary compression/buffering from
// turning a stream of tiny model tokens into a response delivered only at the end.
export const NDJSON_HEADERS = {
  'content-type':'application/x-ndjson; charset=utf-8',
  'cache-control':'no-store, no-transform',
  'x-accel-buffering':'no',
};
const PADDING='{"event":"heartbeat"}'+' '.repeat(16364)+'\n';

export class EventWriter {
  #writer;#onGone;#encoder=new TextEncoder();#tail=Promise.resolve();#pending=0;#timer;#writeTimeout;
  gone=false;
  constructor(writable,onGone,{heartbeatMs=2000,writeTimeoutMs=10000}={}){
    this.#writer=writable.getWriter();this.#onGone=onGone;this.#writeTimeout=writeTimeoutMs;
    this.#timer=setInterval(()=>{if(!this.gone&&!this.#pending)void this.#write(this.#encoder.encode(PADDING));},heartbeatMs);
  }
  async #write(bytes){
    if(this.gone)return;
    this.#pending++;
    const run=async()=>{
      if(this.gone)return;
      let timer;
      try{
        await Promise.race([this.#writer.write(bytes),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Client stopped reading the reply.')),this.#writeTimeout);})]);
      }catch{this.markGone();}
      finally{clearTimeout(timer);}
    };
    const write=this.#tail.then(run,run);this.#tail=write;
    try{await write;}finally{this.#pending--;}
  }
  send(event){if(event.event==='done'||event.event==='error')clearInterval(this.#timer);return this.#write(this.#encoder.encode(JSON.stringify(event)+'\n'));}
  markGone(){
    if(this.gone)return;this.gone=true;clearInterval(this.#timer);this.#onGone();
    void this.#writer.abort().catch(()=>{});
  }
  async close(){
    clearInterval(this.#timer);await this.#tail;
    let timer;
    try{await Promise.race([this.gone?this.#writer.abort():this.#writer.close(),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}
    catch{/* The disconnected stream is already closed/errored. */}
    finally{clearTimeout(timer);}
  }
}
