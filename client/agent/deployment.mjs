import fs from 'node:fs';
export function validateRelayOrigin(value){
  if(typeof value!=='string'||!value)return '';
  let url;try{url=new URL(value);}catch{throw new Error('Invalid configured deployment URL.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('The deployment must be an HTTPS origin without credentials or a path.');
  return url.origin;
}
let configuration={};
for(const name of ['deployment.local.json','deployment.json'])try{const file=new URL('./'+name,import.meta.url),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('Invalid deployment file.');configuration=JSON.parse(fs.readFileSync(file,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw new Error('Could not read this setup package’s deployment configuration.');}
export const RELAY_ORIGIN=validateRelayOrigin(process.env.NODE_ENV==='test'&&process.env.QWEN_RELAY_ORIGIN?process.env.QWEN_RELAY_ORIGIN:configuration.relay_origin||'');
export function requireRelayOrigin(){if(!RELAY_ORIGIN)throw new Error('This setup package is not linked to a deployed server. Download a configured package from your own deployment, or configure deployment.json before starting.');return RELAY_ORIGIN;}
