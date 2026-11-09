import http from 'node:http';
import fs from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {AgentEngine,inferRemote} from './engine.mjs';
import {ownCloudConfig,ownCloudRequest} from './cloud.mjs';
import {LocalBrowser} from './browser.mjs';

const assets=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
export async function startLocalServer({workspace,config,stateDir,port=0,infer,cloudFetch=fetch,browserTools}) {
  const token=randomBytes(32).toString('hex');
  const artifactRoot=stateDir||workspace.stateDir;
  const browser=browserTools||new LocalBrowser({artifactDir:artifactRoot?path.join(artifactRoot,'browser-screenshots'):undefined});
  const engine=new AgentEngine(workspace,infer||((messages,signal,status)=>inferRemote(config,messages,signal,status)),{stateDir,browser});
  const own=ownCloudConfig(config);
  let cloud=own?{owner:own.owner,host:'kaggle',server:'checking',detail:'Checking your Kaggle notebook',notebook_url:own.url,expires_at:own.expires_at}:null;
  let cloudPending=null,cloudChecked=0,shutdownRequested=false,controlEpoch=0;
  const checkCloud=async(force=false)=>{
    if(!cloud)return null;if(cloudPending)return cloudPending;if(!force&&Date.now()-cloudChecked<10000)return cloud;
    cloudPending=(async()=>{
      try{const status=await ownCloudRequest(own,'/v1/status',{fetcher:cloudFetch});cloud={...cloud,server:status.server,detail:shutdownRequested?(cloud.shutdown_error||'Shutdown requested. Check your Kaggle notebook to confirm.'):status.boot?.detail||status.detail||status.server,shutting_down:shutdownRequested||!!status.shutting_down};}
      catch(error){cloud={...cloud,server:'unreachable',detail:error.message};}
      finally{cloudChecked=Date.now();cloudPending=null;}
      return cloud;
    })();return cloudPending;
  };
  let origin;
  const server=http.createServer(async(req,res)=>{
    const out=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try {
      // Exact Host, Origin and bearer checks prevent DNS rebinding and cross-site drive-by calls.
      if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return out(403,{error:'Wrong local origin.'});
      const url=new URL(req.url,origin);
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
      if(!url.pathname.startsWith('/api/')){
        if(req.method!=='GET')return out(405,{error:'Method not allowed.'});
        const file={'/':'index.html','/app.js':'app.js','/app.css':'app.css'}[url.pathname];
        if(!file)return out(404,{error:'Not found.'});
        res.writeHead(200,{'content-type':TYPES[path.extname(file)],'cache-control':'no-store'});return res.end(await fs.readFile(path.join(assets,file)));
      }
      const given=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,''));const expected=Buffer.from(token);
      if(given.length!==expected.length||!timingSafeEqual(given,expected))return out(401,{error:'Open the helper using its private launch link.'});
      if(req.method==='GET'&&url.pathname==='/api/state'){void checkCloud();return out(200,{...engine.state(),cloud});}
      if(req.method==='GET'&&url.pathname==='/api/cloud/status')return out(200,await checkCloud(true));
      if(req.method==='GET'&&url.pathname==='/api/files')return out(200,await workspace.listPage(url.searchParams.get('path')||''));
      if(req.method==='GET'&&url.pathname==='/api/file')return out(200,await workspace.read(url.searchParams.get('path')||''));
      if(req.method==='GET'&&/^\/api\/browser\/screenshot\/[A-Za-z0-9-]{36}$/.test(url.pathname)){const bytes=await browser.screenshotBytes(url.pathname.split('/').at(-1));res.writeHead(200,{'content-type':'image/png','cache-control':'no-store'});return res.end(bytes);}
      if(req.method!=='POST'||req.headers['content-type']!=='application/json')return out(405,{error:'Expected a JSON POST.'});
      let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024){out(413,{error:'Request too large.'});req.destroy();return;}chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      if(url.pathname==='/api/task'){if(engine.busy)throw new Error('A task is already running.');const epoch=controlEpoch;const current=await checkCloud(true);if(epoch!==controlEpoch)throw new Error('Task submission was cancelled before starting.');if(shutdownRequested||current&&(current.server!=='ready'||current.shutting_down))throw new Error('Your Kaggle notebook is not ready: '+(current?.detail||'Shutdown requested.'));void engine.start(input.task);return out(202,{ok:true});}
      if(url.pathname==='/api/cloud/shutdown'){if(!own)throw new Error('No personal Kaggle session is connected.');controlEpoch++;shutdownRequested=true;cloud={...cloud,shutting_down:true,shutdown_acknowledged:false,shutdown_error:null,detail:'Requesting shutdown of your Kaggle notebook.'};engine.stop();try{const result=await ownCloudRequest(own,'/v1/server/shutdown',{fetcher:cloudFetch});cloud={...cloud,shutting_down:true,shutdown_acknowledged:true,detail:'Shutdown requested. Check your Kaggle notebook to confirm.'};return out(200,result);}catch(error){cloud={...cloud,shutdown_error:'Shutdown could not be confirmed. Retry or stop the notebook on Kaggle.',detail:'Shutdown could not be confirmed. Retry or stop the notebook on Kaggle.'};throw error;}}
      if(url.pathname==='/api/decide'){engine.decide(input.id,input.approve);return out(200,{ok:true});}
      if(url.pathname==='/api/stop'){controlEpoch++;engine.stop();return out(200,{ok:true});}
      if(url.pathname==='/api/reset'){engine.reset();controlEpoch++;return out(200,{ok:true});}
      return out(404,{error:'No such operation.'});
    }catch(error){if(!res.headersSent)out(400,{error:error.message});else res.end();}
  });
  server.headersTimeout=10000;server.requestTimeout=30000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  if(browser.blockedOrigins)browser.blockedOrigins.push(origin);
  return {server,engine,origin,token,url:origin+'/#'+token,async close(){engine.stop();await browser.close();await engine.work;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
