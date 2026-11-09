import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateRelayOrigin} from '../../client/agent/deployment.mjs';
const origin=validateRelayOrigin(process.argv[2]||'');
if(!origin)throw new Error('Usage: node tools/configure-deployment.mjs https://YOUR-WORKER.workers.dev');
await fs.writeFile(new URL('../../client/agent/deployment.local.json',import.meta.url),JSON.stringify({relay_origin:origin},null,2)+'\n');
for(const name of ['build-local-agent.py','build-colab-notebook.py']){
  const build=spawnSync(process.env.PYTHON||'python',[fileURLToPath(new URL('./'+name,import.meta.url))],{stdio:'inherit',windowsHide:true});
  if(build.status!==0){process.exitCode=1;break;}
}
if(!process.exitCode)console.log('Local-agent package and Colab notebook configured for your deployment. Deploy the updated assets before sharing them.');
