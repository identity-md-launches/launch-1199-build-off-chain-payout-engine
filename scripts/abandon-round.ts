import { pathToFileURL } from 'node:url';
import type { Hex,TransactionReceipt } from 'viem';
import { loadConfig,type Config } from '../src/config.js';
import { Store,ledgerHash,canonical } from '../src/ledger.js';
import { RPC } from '../src/rpc.js';
import { LiveChain,type ExecutorChain } from '../src/executor.js';
import { chunks } from '../src/payout.js';
import type { EngineState } from '../src/rounds.js';
import { acquireLock } from '../src/lock.js';
/** Operator-requested release of unsent chunks. Never broadcasts; every signed intent must already be resolved. */
export async function abandonPrepared(c:Config,store:Store,chain:ExecutorChain,receiptFor:(hash:Hex)=>Promise<TransactionReceipt>,head:bigint){
  if(c.executor!=='live')throw new Error('Abandonment is for live prepared rounds');
  const engine=store.read<EngineState|null>('private/engine.json',null),intent=engine?.intent;
  if(!engine||!intent)throw new Error('No prepared round');
  const ledger=intent.ledger,epoch=ledger.epochIndex,hash=ledgerHash(ledger),parts=chunks(ledger,c.rules.maxRecipientsPerTx);
  const operations=store.read<Record<string,{hash:Hex}>>('private/transactions.json',{}),receipts=new Map<string,TransactionReceipt>();
  for(const [id,op] of Object.entries(operations))if(id.startsWith(`epoch:${epoch}:`)){
    const receipt=await receiptFor(op.hash);
    if(head<receipt.blockNumber+BigInt(c.exec.confirmations)-1n)throw new Error('An operation is not yet confirmed');
    receipts.set(id,receipt);
  }
  const account=store.read<{credits:Record<string,bigint>;debits:Record<string,bigint>}>('private/funding-account.json',{credits:{},debits:{}});
  const execution=store.read<{fundAmount?:bigint;fundReceipt?:TransactionReceipt}>(`private/execution-${epoch}.json`,{}),fundId=`epoch:${epoch}:fund`,fundReceipt=receipts.get(fundId)||execution.fundReceipt;
  if(fundReceipt?.status==='success'){
    if(!execution.fundAmount||!await chain.fundingProof(fundReceipt,execution.fundAmount))throw new Error('Funding remains unproved');
    account.credits[fundId]=execution.fundAmount;
  }
  let spent=0n,recipients=0,failed=0;const roundIds:string[]=[];
  for(const part of parts){
    if(await chain.isPaid(part.roundId)){
      const evidence=await chain.evidence(part.roundId);
      if(evidence.ledgerHash!==hash||evidence.legs.length!==part.payees.length||!part.payees.every(p=>evidence.legs.some(e=>e.to.toLowerCase()===p.payee.toLowerCase()&&e.amount===p.amount)))throw new Error('Paid chunk conflicts with prepared ledger');
      const amount=part.payees.reduce((n,p)=>n+p.amount,0n);account.debits[part.roundId.toString()]=amount;spent+=amount;recipients+=part.payees.length;roundIds.push(part.roundId.toString());
      for(const p of part.payees)if(await chain.failed(part.roundId,p.payee)>0n)failed++;
    }else if(receipts.get(`epoch:${epoch}:pay:${part.chunkIndex}`)?.status==='success')throw new Error('Successful pay receipt without isPaid');
  }
  // This marker prevents the daemon from resuming the plan if the maintenance process dies between writes.
  const record={epoch,ledgerHash:hash,planned:ledger.pot-ledger.leftover,spent,released:ledger.pot-ledger.leftover-spent,roundIds};
  store.immutable(`private/abandoned-${epoch}.json`,record);store.write('private/funding-account.json',account);
  engine.treasury={...intent.booked,pot:ledger.pot-spent};engine.completedEpoch=epoch;engine.intent=null;engine.collection=null;
  engine.rounds.push({epochIndex:epoch,closeTs:ledger.closeTs,closeX96:ledger.closeX96,ledgerHash:hash,amount:spent,recipients,failed,mode:'live',claimThroughBlock:intent.claimThroughBlock,roundIds,status:'abandoned'});
  store.write('private/engine.json',engine);return record;
}
export async function main(){
  const c=loadConfig(),store=new Store(c.dataDir),release=await acquireLock(store.path('private/writer.lock'));
  try{const rpc=new RPC(c,store);await rpc.validate();const chain=new LiveChain(c,rpc,undefined as any);await chain.verifyOwner();
    const result=await abandonPrepared(c,store,chain,hash=>rpc.priority.getTransactionReceipt({hash}),await rpc.priority.getBlockNumber({cacheTime:0}));console.log(canonical(result));
  }finally{await release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Abandonment refused: stop rounds, resolve every signed transaction, and verify the prepared ledger');process.exitCode=1;});
