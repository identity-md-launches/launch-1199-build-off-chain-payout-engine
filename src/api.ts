import { createServer, type Server } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve,relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { address, loadConfig, type Config } from './config.js';
import { canonical, Store } from './ledger.js';
import { eligibility, emptyWallet } from './eligibility.js';
import { allocate } from './payout.js';
import type { EngineView } from './rounds.js';
export function walletResponse(c:Config,view:EngineView,input:string){
  const a=address(input),all=view.wallets.map(w=>eligibility(w,view.closeX96,c.rules.minBuy));
  const wallet=all.find(w=>w.address===a)||eligibility(emptyWallet(a),view.closeX96,c.rules.minBuy);
  const plan=allocate(all,view.treasury.pot,c.rules.minPayout);
  return {...wallet,nextDropEstimate:plan.payees.find(p=>p.payee===a)?.amount||0n,nextDropAt:view.nextDropAt,asOfBlock:view.head,mode:view.mode};
}
export function createAPI(c:Config,store=new Store(c.dataDir)):Server {
  return createServer((req,res)=>{
    const send=(code:number,value:unknown)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(canonical(value));};
    if(req.method!=='GET')return send(405,{error:'GET only'});
    let path:string;try{path=decodeURIComponent(new URL(req.url||'/', 'http://localhost').pathname);}catch{return send(400,{error:'Invalid path'});}
    try {
      if(path==='/api/status')return send(200,JSON.parse(readFileSync(store.path('status.json'),'utf8')));
      if(path.startsWith('/api/wallet/')){
        const view=store.read<EngineView|null>('private/view.json',null);if(!view)return send(503,{error:'Indexer is warming up'});
        try{return send(200,walletResponse(c,view,path.slice('/api/wallet/'.length)));}catch{return send(400,{error:'Invalid wallet address'});}
      }
      if(/^\/data\/(token|status|treasury|rounds|chart|leaderboard|wallets|ledgers)\.json$/.test(path)||/^\/data\/ledgers\/[1-9][0-9]*\.json$/.test(path)) {
        const file=store.path(path.slice('/data/'.length)),real=realpathSync(file);
        const target=relative(realpathSync(c.dataDir),real).split('\\').join('/');
        if(!/^(token|status|treasury|rounds|chart|leaderboard|wallets|ledgers)\.json$/.test(target)&&!/^ledgers\/[1-9][0-9]*\.json$/.test(target))return send(404,{error:'Not found'});
        return send(200,JSON.parse(readFileSync(file,'utf8')));
      }
      return send(404,{error:'Not found'});
    }catch{return send(503,{error:'Snapshot not available'});}
  });
}
export function main(){const c=loadConfig();createAPI(c).listen(c.api.port,c.api.host,()=>console.log(`Data service listening on ${c.api.host}:${c.api.port}`));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
