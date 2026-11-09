import BASE_BUILDER from '../tools/build-kaggle-cache.py';
import BUILDER from './personal-cache-builder.py';
import RUNTIME from './personal-cache-runtime.py';

const MODEL_REPO='HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF';
export async function createPersonalCacheSpec(model=null){
  const pinned=model?{
    url:model.url,repo:model.repo,revision:model.revision,file:model.file,sha256:model.sha256,bytes:model.bytes,quant:model.quant,profile_id:model.profile_id,label:model.label,context:model.context,
  }:null;
  if(pinned&&(!/^[a-f0-9]{40}$/.test(pinned.revision)||!/^[a-f0-9]{64}$/.test(pinned.sha256)||!Number.isSafeInteger(pinned.bytes)||pinned.bytes<100*1024**2||pinned.bytes>24*1024**3))throw new Error('Invalid pinned cache model.');
  const source={schema:pinned?2:1,model:pinned,model_url:pinned?.url||null,default_model:{repo:MODEL_REPO,revision:'993a5971fda8f30dd1b7eb2654792ba4415c7460',quant:'Q5_K_P'},runtime:{ollama:'0.40.11',cloudflared:'2026.10.3'}};
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(source))))].map(n=>n.toString(16).padStart(2,'0')).join('');
  return {...source,cache_id:'agent-cache-v1-'+digest.slice(0,32)};
}

export function personalCacheBuilderScript(spec,{owner,relay,token,buildId}){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(owner)||!/^[a-f0-9]{32}$/.test(buildId)||!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid cache builder identity.');
  const url=new URL(relay);if(url.protocol!=='https:'||!/^\/_agent-cache\/[a-f0-9]{40}$/.test(url.pathname)||url.search||url.hash||url.username||url.password)throw new Error('Invalid cache callback.');
  const base=BASE_BUILDER.split(/\r?\nif __name__ == "__main__":/)[0];
  return base+'\nPERSONAL_CACHE_SPEC = json.loads('+JSON.stringify(JSON.stringify(spec))+')\nPERSONAL_CACHE_CONTROL = json.loads('+JSON.stringify(JSON.stringify({owner,relay,token,build_id:buildId}))+')\n'+BUILDER;
}

export function personalCacheRuntimeScript(spec){return '\nPERSONAL_CACHE_SPEC = json.loads('+JSON.stringify(JSON.stringify(spec))+')\n'+RUNTIME+'\n';}
