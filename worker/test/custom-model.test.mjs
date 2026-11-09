import {test} from 'node:test';
import assert from 'node:assert/strict';
import {huggingFaceSource,resolveHuggingFaceModel} from '../src/custom-model.js';
const url='https://huggingface.co/example/model-GGUF';
const sha='a'.repeat(64),revision='b'.repeat(40);
const metadata={sha:revision,siblings:[{rfilename:'model-Q4_K_M.gguf',size:5e9,lfs:{sha256:sha,size:5e9}},{rfilename:'mmproj-F16.gguf',size:1e9,lfs:{sha256:sha,size:1e9}}]};
test('Hugging Face-only links normalize repository and GGUF URLs without credentials',()=>{
  assert.equal(huggingFaceSource(url+'/').url,url);
  assert.equal(huggingFaceSource(url+'/resolve/main/model-Q4_K_M.gguf?download=true').url,url+'/blob/main/model-Q4_K_M.gguf');
  for(const input of ['http://huggingface.co/a/b','https://ollama.com/library/qwen','https://huggingface.co.evil.test/a/b','https://token@huggingface.co/a/b',url+'?token=private',url+'/blob/main/weights.safetensors',url+'/blob/main/mmproj-F16.gguf',url+'/blob/main/model-00001-of-00002.gguf','file:///C:/model.gguf'])assert.throws(()=>huggingFaceSource(input),e=>e.code==='unsupported_model');
});
test('public metadata pins a single model digest and source commit before any GPU launch',async()=>{
  const calls=[];const spec=await resolveHuggingFaceModel(url,{fetcher:async(path,options)=>{calls.push([path,options]);return Response.json(metadata);}});
  assert.equal(spec.file,'model-Q4_K_M.gguf');assert.equal(spec.sha256,sha);assert.equal(spec.revision,revision);assert.equal(spec.quant,'Q4_K_M');assert.equal(spec.context,32768);assert.equal(spec.num_batch,128);
  assert.equal(calls.length,1);assert(calls[0][0].startsWith('https://huggingface.co/api/models/'));assert.equal(calls[0][1].redirect,'error');assert.equal(calls[0][1].headers.authorization,undefined);
});
test('private, invalid, oversized and split models fail without a provider fallback',async()=>{
  await assert.rejects(resolveHuggingFaceModel(url,{fetcher:async()=>new Response('',{status:401})}),e=>e.code==='unsupported_model');
  for(const info of [{...metadata,sha:'main'},{...metadata,siblings:[{...metadata.siblings[0],lfs:{sha256:sha,size:30*1024**3}}]},{...metadata,siblings:[{...metadata.siblings[0],lfs:{sha256:'bad',size:5e9}}]}])await assert.rejects(resolveHuggingFaceModel(url,{fetcher:async()=>Response.json(info)}),e=>e.code==='unsupported_model');
  await assert.rejects(resolveHuggingFaceModel(url,{fetcher:async()=>{throw new Error('network');}}),e=>e.code==='model_lookup_failed');
});
test('custom URLs cannot make the metadata fetcher contact another host',async()=>{let calls=0;await assert.rejects(resolveHuggingFaceModel('https://localhost/model.gguf',{fetcher:async()=>{calls++;}}));assert.equal(calls,0);});
