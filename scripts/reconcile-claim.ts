import { pathToFileURL } from 'node:url';
import { loadConfig,hash } from '../src/config.js';
import { RPC } from '../src/rpc.js';
import { Indexer } from '../src/indexer.js';
import { canonical,Store } from '../src/ledger.js';
import { acquireLock } from '../src/lock.js';
export async function main(){
  const c=loadConfig(),store=new Store(c.dataDir),release=await acquireLock(store.path('private/writer.lock'));
  try{
    const tx=hash(process.argv[process.argv.indexOf('--tx')+1],'--tx'),rpc=new RPC(c,store);await rpc.validate();
    const receipt=await rpc.priority.getTransactionReceipt({hash:tx}),head=await rpc.safeHead();
    if(receipt.status!=='success'||receipt.blockNumber>head||receipt.blockNumber<c.launch.launchBlock)throw new Error('Sweep is unsuccessful, unconfirmed or before launch');
    const indexer=new Indexer(c,rpc,store);await indexer.sync(head,rpc.priority);
    const claims=indexer.rebuild().receipts.filter(r=>r.transactionHash===tx&&r.kind==='sweep');
    if(!claims.length)throw new Error('No verified hook sweep to payout wallet in this transaction');
    const file='private/reconciled-claims.json',prior=store.read<Record<string,unknown>>(file,{});
    prior[tx]={transactionHash:tx,blockNumber:receipt.blockNumber,claims};store.write(file,prior);
    console.log(canonical({recorded:claims,booking:'Deduplicated by event ID in the next drop'}));
  }finally{await release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Reconciliation failed; stop the rounds writer and verify the confirmed sweep transaction');process.exitCode=1;});
