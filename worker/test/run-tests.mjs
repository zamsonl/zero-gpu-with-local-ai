import {spawn} from 'node:child_process';
// A public checkout has no deployment origin. Fixtures must use an inert origin,
// never a maintainer's service or a developer's configured account.
const child=spawn(process.execPath,process.argv.slice(2),{stdio:'inherit',windowsHide:true,env:{...process.env,NODE_ENV:'test',QWEN_RELAY_ORIGIN:'https://relay.example.invalid'}});
child.once('error',()=>{process.exitCode=1;});child.once('close',code=>{process.exitCode=code??1;});
