import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { Store, canonical, ledgerHash } from './ledger.js';
import { RPC, sleep } from './rpc.js';
import { Indexer, rebuild, type Event } from './indexer.js';
import { Wallet, SendPending } from './wallet.js';
import { Executor, LiveChain } from './executor.js';
import { bookClaim, bookRefunds, emptyTreasury, pending, sweepCall, distributorCall, type Treasury } from './fees.js';
import { eligibility, type WalletLedger } from './eligibility.js';
import { epochClose, epochIndex, twap } from './twap.js';
import { makeLedger, allocate, chunks, type DropLedger } from './payout.js';
import { Alerts } from './alerts.js';
import { acquireLock } from './lock.js';
export type RoundSummary={epochIndex:number;closeTs:number;ledgerHash:string;amount:bigint;recipients:number;failed:number;mode:string;claimThroughBlock:bigint;status?:'abandoned';roundIds?:string[];closeX96?:bigint};
type Collection={startedAt:number;epoch:number;hookDone:boolean;distributorDone:boolean;throughBlock:bigint};
type Intent={startedAt:number;ledger:DropLedger;booked:Treasury;claimThroughBlock:bigint};
export type EngineState={mode:'dry-run'|'live';completedEpoch:number;treasury:Treasury;simulatedPaid:Record<string,bigint>;rounds:RoundSummary[];intent:Intent|null;collection:Collection|null;skipped:{from:number;to:number}[]};
export type EngineView={mode:string;head:bigint;headTimestamp:number;lastProgressAt:number;nextEpoch:number;nextDropAt:number;closeX96:bigint;spotX96:bigint;wallets:WalletLedger[];treasury:Treasury;rounds:RoundSummary[];skipped:{from:number;to:number}[];stalled:boolean;intentEpoch:number|null};
export const initialEngine=(c:Config):EngineState=>({mode:c.executor,completedEpoch:0,treasury:emptyTreasury(c.ops.dexReserve),simulatedPaid:{},rounds:[],intent:null,collection:null,skipped:[]});
/** Pure offline replay uses epoch boundaries as claim cutoffs, or the exact recorded cutoff for actual drops. */
export function replayEvents(events:readonly Event[],c:Config,throughEpoch:number,cutoffs:Record<number,bigint>={},contracts:ReadonlySet<string>=new Set(),contractBlocks:Record<string,bigint>={},actualDebits:Record<number,bigint>={}):DropLedger[] {
  let treasury=emptyTreasury(c.ops.dexReserve);const simulated:Record<string,bigint>={},ledgers:DropLedger[]=[],knownIds=new Set<string>();
  const recorded=Object.keys(cutoffs).map(Number).filter(e=>e<=throughEpoch).sort((a,b)=>a-b);
  const epochs=recorded.length?recorded:Array.from({length:throughEpoch},(_,i)=>i+1);
  for(const epoch of epochs) {
    const closeTs=epochClose(c.launch.launchTs,epoch),before=events.filter(e=>e.timestamp<closeTs);
    const boundary=before.reduce((n,e)=>n>e.blockNumber?n:e.blockNumber,c.launch.launchBlock);
    const codeAt=(block:bigint)=>new Set([...contracts].filter(a=>(contractBlocks[a]??c.launch.launchBlock)<=block));
    const state=rebuild(before,c,codeAt(boundary)),close=twap(state.observations,closeTs);
    const cutoff=cutoffs[epoch],atClaim=cutoff===undefined?state:rebuild(events,c,codeAt(cutoff),cutoff);
    treasury=bookRefunds(bookClaim(treasury,atClaim.receipts,c.ops.skimFraction),atClaim.refunds,knownIds);
    const wallets=[...state.wallets.values()].map(w=>{
      const current=atClaim.wallets.get(w.address)||w;
      return eligibility({...w,disqualified:w.disqualified||current.disqualified,reason:current.disqualified?current.reason:w.reason,
        paid:current.paid+(simulated[w.address]||0n),reserved:current.reserved},close,c.rules.minBuy);
    });
    const ledger=makeLedger(epoch,closeTs,close,wallets,treasury.pot,c.rules.minPayout);ledgers.push(ledger);treasury.pot=actualDebits[epoch]===undefined?ledger.leftover:ledger.pot-actualDebits[epoch];for(const p of chunks(ledger,c.rules.maxRecipientsPerTx))knownIds.add(p.roundId.toString());
    // Actual Paid/PayFailed/WrittenOff logs replace simulated outcomes for executed epochs.
    const executed=actualDebits[epoch]!==undefined||events.some(e=>e.name==='RoundPaid'&&e.address.toLowerCase()===c.launch.roundPayout.toLowerCase()&&BigInt(e.args.roundId)/1000n===BigInt(epoch));
    if(!executed)for(const p of ledger.payees)simulated[p.payee]=(simulated[p.payee]||0n)+p.amount;
  }
  return ledgers;
}
export class RoundRunner {
  state:EngineState;private lastHeartbeat=0;private lastStallAlert=0;
  constructor(readonly c:Config,readonly rpc:RPC,readonly indexer:Indexer,readonly executor:Executor,readonly alerts:Alerts,readonly wallet?:Wallet,readonly store:Store=rpc.store){
    this.state=store.read('private/engine.json',initialEngine(c));
    if(this.state.mode!==c.executor)throw new Error('Use a separate DATA_DIR when changing executor mode');
  }
  private save(){this.store.write('private/engine.json',this.state);}
  private async collect(epoch:number,head:bigint):Promise<boolean> {
    if(this.c.executor==='dry-run')return true;
    if(!this.wallet)throw new Error('Missing signer');
    if(!this.state.collection){this.state.collection={startedAt:Date.now(),epoch,hookDone:false,distributorDone:false,throughBlock:head};this.save();}
    const stage=this.state.collection;if(stage.epoch!==epoch)throw new Error('Another epoch is collecting');
    const amounts=await pending(this.rpc.priority,this.c.launch);
    if(!stage.hookDone){
      if(amounts.hook>0n){const receipt=await this.wallet.send(`epoch:${epoch}:sweep`,sweepCall(this.c.launch));stage.throughBlock=receipt.blockNumber>stage.throughBlock?receipt.blockNumber:stage.throughBlock;}
      stage.hookDone=true;this.save();
    }
    if(!stage.distributorDone){
      if(amounts.distributor>0n){const receipt=await this.wallet.send(`epoch:${epoch}:claim`,distributorCall(this.c.launch));stage.throughBlock=receipt.blockNumber>stage.throughBlock?receipt.blockNumber:stage.throughBlock;}
      stage.distributorDone=true;this.save();
    }
    return head>=stage.throughBlock;
  }
  async tick():Promise<boolean> {
    // Head selection occurs before entering the priority-pinned payout round.
    const head=await this.rpc.safeHead();
    const pinned=this.rpc.priority;
    if(BigInt(await pinned.getBlockNumber({cacheTime:0}))<head)throw new Error('Priority node behind safe head');
    await this.indexer.sync(head);
    const header=await this.indexer.headers.exact(head,pinned,true);
    if(this.indexer.state.head!==head||this.indexer.state.headHash&&header.hash!==this.indexer.state.headHash)throw new Error('Priority snapshot differs from indexed frontier');
    const latest=epochIndex(this.c.launch.launchTs,Number(header.timestamp));
    await this.publishView(Number(header.timestamp));
    if(this.state.intent){if(this.store.read(`private/abandoned-${this.state.intent.ledger.epochIndex}.json`,null))throw new Error('Finish interrupted abandonment before resuming');await this.finish();return true;}
    if(this.c.executor==='live'&&this.state.completedEpoch===0&&this.indexer.state.events.some(e=>e.name==='RoundPaid'&&e.address.toLowerCase()===this.c.launch.roundPayout.toLowerCase()))throw new Error('Existing payouts require restored engine journals');
    if(latest<=this.state.completedEpoch)return false;
    let epoch=this.state.collection?.epoch||this.state.completedEpoch+1;
    // A live service does not pay obsolete market losses after downtime. Record missed drops explicitly.
    if(this.c.executor==='live'&&!this.state.collection&&epoch<latest){this.state.skipped.push({from:epoch,to:latest-1});epoch=latest;this.state.completedEpoch=latest-1;this.save();}
    if(!await this.collect(epoch,head))return false;
    const closeTs=epochClose(this.c.launch.launchTs,epoch),boundary=await this.indexer.headers.before(closeTs,head,pinned);
    const current=this.indexer.rebuild();
    if(this.c.executor==='live')await this.indexer.markContracts([...current.wallets.values()].filter(w=>w.qualifyingTokens>0n&&!w.disqualified).map(w=>w.address),head,pinned);
    const historical=this.indexer.rebuild(boundary),now=this.indexer.rebuild();
    const close=twap(historical.observations,closeTs);
    const wallets=[...historical.wallets.values()].map(w=>{
      const live=now.wallets.get(w.address);
      // Outflows/contracts discovered since close void coverage before a delayed live send.
      const adjusted=this.c.executor==='live'&&live?{...w,disqualified:w.disqualified||live.disqualified,reason:live.disqualified?live.reason:w.reason,paid:live.paid,reserved:live.reserved}:w;
      return eligibility({...adjusted,paid:adjusted.paid+(this.state.simulatedPaid[w.address]||0n)},close,this.c.rules.minBuy);
    });
    const claimThroughBlock=this.c.executor==='live'?head:boundary;
    const receipts=this.indexer.rebuild(claimThroughBlock).receipts;
    const claimState=this.indexer.rebuild(claimThroughBlock);
    const booked=bookRefunds(bookClaim(this.state.treasury,receipts,this.c.ops.skimFraction),claimState.refunds,this.knownRoundIds());
    this.executor.creditWriteOffs(claimState.refunds);
    const ledger=makeLedger(epoch,closeTs,close,wallets,booked.pot,this.c.rules.minPayout);
    this.store.immutable(`ledgers/${epoch}.json`,ledger);
    this.state.intent={startedAt:this.state.collection?.startedAt||Date.now(),ledger,booked,claimThroughBlock};this.save();
    await this.finish();return true;
  }
  private knownRoundIds(){return new Set(this.state.rounds.flatMap(r=>r.roundIds||[]));}
  private async finish(){
    const intent=this.state.intent!;const result=await this.executor.execute(intent.ledger),l=intent.ledger;
    this.state.treasury={...intent.booked,pot:l.leftover};
    const executedOnChain=this.indexer.state.events.some(e=>e.name==='RoundPaid'&&e.address.toLowerCase()===this.c.launch.roundPayout.toLowerCase()&&BigInt(e.args.roundId)/1000n===BigInt(l.epochIndex));
    if(result.dryRun&&!executedOnChain)for(const p of l.payees)this.state.simulatedPaid[p.payee]=(this.state.simulatedPaid[p.payee]||0n)+p.amount;
    this.state.rounds.push({epochIndex:l.epochIndex,closeTs:l.closeTs,ledgerHash:ledgerHash(l),amount:l.pot-l.leftover,recipients:l.payees.length,failed:result.failed,mode:this.c.executor,claimThroughBlock:intent.claimThroughBlock,roundIds:chunks(l,this.c.rules.maxRecipientsPerTx).map(p=>p.roundId.toString()),closeX96:l.closeX96});
    this.state.completedEpoch=l.epochIndex;this.state.intent=null;this.state.collection=null;this.save();
    console.log(canonical({event:result.dryRun?'would-pay':'round-complete',epoch:l.epochIndex,payees:l.payees,ledgerHash:ledgerHash(l),leftover:l.leftover}));
  }
  async publishView(headTimestamp:number){
    if(!this.indexer.state.events.some(e=>e.name==='Initialize'))return;
    const state=this.indexer.rebuild(),closed=epochIndex(this.c.launch.launchTs,headTimestamp);
    const close=closed>0?twap(state.observations,epochClose(this.c.launch.launchTs,closed)):state.pool.initialPriceX96;
    const wallets=[...state.wallets.values()].map(w=>({...w,paid:w.paid+(this.state.simulatedPaid[w.address]||0n)}));
    const treasury=bookRefunds(bookClaim(this.state.treasury,state.receipts,this.c.ops.skimFraction),state.refunds,this.knownRoundIds());
    const view:EngineView={mode:this.c.executor,head:this.indexer.state.head,headTimestamp,lastProgressAt:this.indexer.state.lastProgressAt,nextEpoch:closed+1,nextDropAt:epochClose(this.c.launch.launchTs,closed+1),closeX96:close,
      spotX96:state.observations.at(-1)?.priceX96||close,wallets,treasury,rounds:this.state.rounds,skipped:this.state.skipped,stalled:this.isStalled(),intentEpoch:this.state.intent?.ledger.epochIndex||this.state.collection?.epoch||null};
    this.store.write('private/view.json',view);
  }
  private isStalled(){
    const now=Date.now(),started=this.state.intent?.startedAt||this.state.collection?.startedAt;
    return now-this.indexer.state.lastProgressAt>this.c.ops.stallSeconds*1000||Boolean(started&&now-started>this.c.ops.stallSeconds*1000);
  }
  async monitor(){
    const now=Date.now();
    const stale=now-this.indexer.state.lastProgressAt>this.c.ops.stallSeconds*1000;
    const due=this.state.intent||this.state.collection;
    if(this.isStalled()&&now-this.lastStallAlert>this.c.ops.stallSeconds*1000){this.lastStallAlert=now;await this.alerts.send('stalled',{reason:stale?'indexer has not advanced':'round remains pending'});}
    if(now-this.lastHeartbeat>this.c.ops.heartbeatSeconds*1000){this.lastHeartbeat=now;await this.alerts.send('heartbeat',{epoch:this.state.completedEpoch});}
  }
}
export async function main(){
  const c=loadConfig(),store=new Store(c.dataDir),release=await acquireLock(store.path('private/writer.lock'));
  let monitor:ReturnType<typeof setInterval>|undefined;
  let running=true;for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{running=false;});
  try {
    const rpc=new RPC(c,store);await rpc.validate();
    const decimals=Number(await rpc.priority.readContract({address:c.launch.token,abi:[{type:'function',name:'decimals',stateMutability:'view',inputs:[],outputs:[{type:'uint8'}]}],functionName:'decimals'}));
    if(decimals!==c.launch.tokenDecimals)throw new Error('Token decimals mismatch');
    const indexer=new Indexer(c,rpc,store),alerts=new Alerts(store);
    const wallet=c.executor==='live'?Wallet.fromEnvironment(c,rpc,store):undefined;
    const live=wallet?new LiveChain(c,rpc,wallet,()=>indexer.state):undefined;if(live)await live.verifyOwner();
    const executor=new Executor(c,live,store,alerts),runner=new RoundRunner(c,rpc,indexer,executor,alerts,wallet,store);
    monitor=setInterval(()=>{void runner.monitor().catch(()=>console.error('Monitor unavailable'));},Math.min(10000,c.ops.stallSeconds*1000));
    while(running){
      try{const worked=await runner.tick();if(process.argv.includes('--once')&&!worked&&!runner.state.intent&&!runner.state.collection){const view=store.read<EngineView>('private/view.json',null as any);console.log(canonical({event:'next-epoch-preview',epoch:view.nextEpoch,at:view.nextDropAt,usingCloseX96:view.closeX96,...allocate(view.wallets.map(w=>eligibility(w,view.closeX96,c.rules.minBuy)),view.treasury.pot,c.rules.minPayout)}));break;}}
      catch(error){console.error(`Round stalled (${error instanceof Error?error.name:'Error'}); retained durable state`);if(process.argv.includes('--once'))throw new Error('Backfill did not complete');}
      await runner.monitor();if(running)await sleep(c.rpc.pollMs);
    }
  } finally {if(monitor)clearInterval(monitor);await release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Rounds stopped; check launch configuration, RPC health, pause state and durable transaction journal');process.exitCode=1;});
