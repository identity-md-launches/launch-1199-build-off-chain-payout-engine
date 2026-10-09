import { pathToFileURL } from 'node:url';
import { loadConfig,address } from '../src/config.js';
import { Store } from '../src/ledger.js';
import { RPC } from '../src/rpc.js';
import { Indexer } from '../src/indexer.js';
import { Wallet } from '../src/wallet.js';
import { Executor,LiveChain } from '../src/executor.js';
import { Alerts } from '../src/alerts.js';
import { acquireLock } from '../src/lock.js';
export async function main(){
  const [action,rawRound,...args]=process.argv.slice(2),c=loadConfig();
  if(c.executor!=='live'||!['retry','write-off'].includes(action)||!/^\d+$/.test(rawRound||''))throw new Error('Usage: retry ROUND_ID ATTEMPT ADDRESS... | write-off ROUND_ID ADDRESS');
  const store=new Store(c.dataDir),release=await acquireLock(store.path('private/writer.lock'));
  try{const rpc=new RPC(c,store);await rpc.validate();const indexer=new Indexer(c,rpc,store);await indexer.sync(await rpc.safeHead(),rpc.priority);const chain=new LiveChain(c,rpc,Wallet.fromEnvironment(c,rpc,store),()=>indexer.state);await chain.verifyOwner();const executor=new Executor(c,chain,store,new Alerts(store));
    if(action==='retry'){const attempt=Number(args.shift());if(!Number.isSafeInteger(attempt)||attempt<1||!args.length)throw new Error('Supply a positive attempt and recipients');await executor.retryFailed(BigInt(rawRound),args.map(x=>address(x)),attempt);}
    else {if(args.length!==1)throw new Error('Write-off accepts one recipient');await executor.writeOffFailed(BigInt(rawRound),address(args[0]));}
  }finally{await release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Failed-leg operation stopped; inspect pause state and transaction journal');process.exitCode=1;});
