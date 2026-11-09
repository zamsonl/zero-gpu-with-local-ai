import {HttpError} from './http.js';

const invalid=message=>new HttpError(400,'unsupported_model',message);
export function huggingFaceSource(value){
  if(typeof value!=='string'||value.length>2048)throw invalid('Hugging Face GGUF only. Paste a public model repository or single .gguf file link.');
  let url;try{url=new URL(value.trim());}catch{throw invalid('Hugging Face GGUF only. Use an https://huggingface.co/… link.');}
  if(url.protocol!=='https:'||url.hostname!=='huggingface.co'||url.port||url.username||url.password||url.hash||[...url.searchParams].some(([k,v])=>k!=='download'||v!=='true'))throw invalid('Hugging Face GGUF only. Other hosts, credentials and token-bearing links are not supported.');
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length<2||parts.some(part=>!part||!/^[-A-Za-z0-9_.]+$/.test(part)||part==='.'||part==='..')||!/^[-A-Za-z0-9_]+$/.test(parts[0]))throw invalid('Use a Hugging Face model repository or a single GGUF file link.');
  const repo=parts.slice(0,2).join('/');let revision='main',file=null;
  if(parts.length>2){if(!['blob','resolve'].includes(parts[2])||parts.length<5)throw invalid('Open Files in the Hugging Face repository and copy the .gguf file link.');revision=parts[3];file=parts.slice(4).join('/');if(!/\.gguf$/i.test(file)||/(?:^|\/)mmproj|\d{5}-of-\d{5}/i.test(file))throw invalid('Choose a complete single-file GGUF chat model, not a projector or split shard.');}
  return {repo,revision,file,url:'https://huggingface.co/'+repo+(file?'/blob/'+revision+'/'+file:'')};
}

export async function resolveHuggingFaceModel(value,{fetcher=fetch}={}){
  const source=huggingFaceSource(value);
  let response;try{response=await fetcher(`https://huggingface.co/api/models/${source.repo}/revision/${source.revision}?blobs=true`,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{accept:'application/json'}});}catch{throw new HttpError(503,'model_lookup_failed','Hugging Face metadata could not be reached. No GPU notebook was started.');}
  if(!response.ok){await response.body?.cancel();throw invalid('The Hugging Face model must be public and accessible without a token. Check its repository and revision.');}
  let bytes=0,raw='';const reader=response.body.getReader(),decoder=new TextDecoder();
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>1024*1024)throw invalid('This repository has too much metadata. Choose a smaller GGUF repository.');raw+=decoder.decode(next.value,{stream:true});}raw+=decoder.decode();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let info;try{info=JSON.parse(raw);}catch{throw invalid('Hugging Face returned invalid model metadata.');}
  if(!/^[a-f0-9]{40}$/.test(info.sha||''))throw invalid('The model revision could not be pinned safely.');
  const files=(Array.isArray(info.siblings)?info.siblings:[]).filter(f=>/\.gguf$/i.test(f.rfilename||'')&&!/mmproj|\d{5}-of-\d{5}/i.test(f.rfilename));
  const file=source.file?files.find(f=>f.rfilename===source.file):['Q4_K_M','Q5_K_M','Q6_K','Q8_0'].map(q=>files.find(f=>f.rfilename.endsWith('-'+q+'.gguf')||f.rfilename.endsWith('.'+q+'.gguf'))).find(Boolean);
  const size=file?.lfs?.size??file?.size,sha=file?.lfs?.sha256;
  if(!file||!/^[-A-Za-z0-9_./]+\.gguf$/i.test(file.rfilename)||file.rfilename.split('/').some(p=>p==='.'||p==='..')||!Number.isSafeInteger(size)||size<100*1024*1024||size>24*1024**3||!/^[a-f0-9]{64}$/.test(sha||''))throw invalid('Choose a public, complete GGUF file between 100 MB and 24 GB with verified LFS metadata.');
  const quant=/(?:-|\.)(IQ[0-9A-Z_]+|Q[0-9][A-Z0-9_]*|BF16|F16)\.gguf$/i.exec(file.rfilename)?.[1]?.toUpperCase();
  if(!quant)throw invalid('The GGUF filename must include its quantization, for example model-Q4_K_M.gguf.');
  return {...source,revision:info.sha,file:file.rfilename,sha256:sha,bytes:size,quant,label:file.rfilename.split('/').at(-1).replace(/\.gguf$/i,'').slice(0,100),context:32768,num_batch:128,profile_id:'hfgguf:'+sha.slice(0,24)};
}
