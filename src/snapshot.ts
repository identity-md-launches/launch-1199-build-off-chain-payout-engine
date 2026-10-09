import { pathToFileURL } from 'node:url';
import { decodeEventLog } from 'viem';
import { loadConfig, IMD, Q96, type Config } from './config.js';
import { Store } from './ledger.js';
import { RPC, sleep } from './rpc.js';
import { POOL_ABI } from './indexer.js';
import { priceX96 } from './twap.js';
import { eligibility } from './eligibility.js';
import { allocate } from './payout.js';
import type { EngineView } from './rounds.js';
import { acquireLock } from './lock.js';
export type Prices={imdUsd:number|null;ethUsd:number|null;tokenUsd:number|null;source:string;at:string|null};
export const noPrices=():Prices=>({imdUsd:null,ethUsd:null,tokenUsd:null,source:'unavailable',at:null});
export function usdPrices(ethUsd:number,imdPerEthX96:bigint,tokenPerQuoteX96:bigint,tokenDecimals:number,ethDecimals:number,source:string,at:string):Prices {
  const imdPerEth=Number(imdPerEthX96)/Number(Q96)*10**(ethDecimals-18);
  const imdUsd=ethUsd/imdPerEth,tokenUsd=Number(tokenPerQuoteX96)/Number(Q96)*10**(tokenDecimals-18)*imdUsd;
  if(![ethUsd,imdPerEth,imdUsd,tokenUsd].every(n=>Number.isFinite(n)&&n>0))throw new Error('Invalid display price');
  return {imdUsd,ethUsd,tokenUsd,source,at};
}
export async function ethUsd(c:Config,fetcher:typeof fetch=fetch):Promise<{value:number;source:string}>{
  try {const r=await fetcher(c.prices.coinGeckoUrl,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error();const json:any=await r.json();const value=Number(json?.ethereum?.usd);if(!(value>0&&Number.isFinite(value)))throw new Error();return {value,source:'CoinGecko'};}catch{}
  if(c.prices.dexScreenerUrl){const r=await fetcher(c.prices.dexScreenerUrl,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('ETH/USD source failed');
    const json:any=await r.json(),pairs=Array.isArray(json)?json:json.pairs||[json.pair];
    const pair=pairs.find((p:any)=>['ETH','WETH'].includes(p?.baseToken?.symbol)&&Number(p.priceUsd)>0);
    if(pair&&Number.isFinite(Number(pair.priceUsd)))return {value:Number(pair.priceUsd),source:'Dexscreener'};
  }
  throw new Error('No valid ETH/USD quote');
}
export class PriceFeed {
  private last:Prices;private through:bigint;private spot:bigint|null;private imdIsCurrency1:boolean|null=null;
  constructor(readonly c:Config,readonly rpc:RPC,readonly store:Store){
    const saved=store.read<{prices:Prices;through:bigint;spot:bigint|null;ordering:boolean|null}>('private/prices.json',{prices:noPrices(),through:c.launch.ethImdPool.initializeBlock,spot:null,ordering:null});
    this.last=saved.prices;this.through=saved.through;this.spot=saved.spot;this.imdIsCurrency1=saved.ordering;
  }
  async update(tokenSpot:bigint):Promise<Prices>{
    try{
      const p=this.c.launch.ethImdPool,head=await this.rpc.safeHead();
      if(this.imdIsCurrency1===null){
        const logs=await this.rpc.logs({address:p.poolManager,event:POOL_ABI[0],args:{id:p.poolId}},p.initializeBlock,p.initializeBlock);
        if(logs.length!==1)throw new Error('ETH/IMD Initialize missing');
        const d:any=decodeEventLog({abi:POOL_ABI,data:logs[0].data,topics:logs[0].topics as any}),a=d.args;
        if(![a.currency0.toLowerCase(),a.currency1.toLowerCase()].includes(IMD.toLowerCase())||![a.currency0.toLowerCase(),a.currency1.toLowerCase()].includes(p.ethCurrency.toLowerCase()))throw new Error('ETH/IMD currency mismatch');
        this.imdIsCurrency1=a.currency1.toLowerCase()===IMD.toLowerCase();this.spot=priceX96(a.sqrtPriceX96,this.imdIsCurrency1);
      }
      if(head>=this.through){
        // Backwards search finds the latest spot without scanning the entire ETH pool history on startup.
        for(let end=head;end>=this.through;){const start=end-this.c.rpc.logChunk+1n>this.through?end-this.c.rpc.logChunk+1n:this.through;
          const logs=await this.rpc.logs({address:p.poolManager,event:POOL_ABI[1],args:{id:p.poolId}},start,end);
          if(logs.length){const last=logs.sort((a,b)=>a.blockNumber<b.blockNumber?-1:a.blockNumber>b.blockNumber?1:a.logIndex-b.logIndex).at(-1)!;const d:any=decodeEventLog({abi:POOL_ABI,data:last.data,topics:last.topics as any});this.spot=priceX96(d.args.sqrtPriceX96,this.imdIsCurrency1!);break;}
          if(start===this.through)break;end=start-1n;
        }
        this.through=head+1n;
      }
      const usd=await ethUsd(this.c);
      this.last=usdPrices(usd.value,this.spot!,tokenSpot,this.c.launch.tokenDecimals,p.ethDecimals,`RH ETH/IMD spot + ${usd.source}`,new Date().toISOString());
      this.store.write('private/prices.json',{prices:this.last,through:this.through,spot:this.spot,ordering:this.imdIsCurrency1});
    }catch{/* Retain the last successful complete quote, including its original timestamp. */}
    return this.last;
  }
}
export function publishSnapshots(c:Config,store:Store,view:EngineView,prices:Prices):void {
  const evaluated=view.wallets.map(w=>eligibility(w,view.closeX96,c.rules.minBuy));
  const estimate=allocate(evaluated,view.treasury.pot,c.rules.minPayout),byPayee=new Map(estimate.payees.map(p=>[p.payee,p.amount]));
  const wallets=evaluated.map(w=>({...w,nextDropEstimate:byPayee.get(w.address)||0n}));
  const stalled=view.stalled||Date.now()-view.lastProgressAt>c.ops.stallSeconds*1000;
  store.publish('token.json',{chainId:c.launch.chainId,address:c.launch.token,symbol:'MONEYBACK',quote:IMD,decimals:c.launch.tokenDecimals,poolId:c.launch.poolId});
  const {booked,...publicTreasury}=view.treasury;store.publish('treasury.json',publicTreasury);
  store.publish('rounds.json',view.rounds);store.publish('ledgers.json',view.rounds.map(r=>({epochIndex:r.epochIndex,path:`/data/ledgers/${r.epochIndex}.json`,ledgerHash:r.ledgerHash})));
  store.publish('chart.json',view.rounds.map(r=>({at:r.closeTs,paid:r.amount,closeX96:r.closeX96??null})));
  store.publish('wallets.json',wallets);
  store.publish('leaderboard.json',[...wallets].sort((a,b)=>a.paid>b.paid?-1:a.paid<b.paid?1:a.address.localeCompare(b.address)));
  store.publish('status.json',{mode:view.mode,head:view.head,headTimestamp:view.headTimestamp,stalled,nextEpoch:view.nextEpoch,nextDropAt:view.nextDropAt,closeX96:view.closeX96,prices,
    pot:view.treasury.pot,eligible:wallets.filter(w=>w.eligible).length,wouldPay:estimate.payees,projectedLeftover:estimate.leftover,intentEpoch:view.intentEpoch,skipped:view.skipped,at:new Date().toISOString()});
}
export async function main(){
  const c=loadConfig(),store=new Store(c.dataDir),release=await acquireLock(store.path('private/snapshot.lock'));
  let running=true;for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{running=false;});
  try{const rpc=new RPC(c,store);await rpc.validate();const feed=new PriceFeed(c,rpc,store);
    while(running){const started=Date.now();const view=store.read<EngineView|null>('private/view.json',null);if(view)publishSnapshots(c,store,view,await feed.update(view.spotX96));if(process.argv.includes('--once'))break;await sleep(Math.max(1,c.prices.intervalMs-(Date.now()-started)));}
  }finally{await release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Snapshot service stopped');process.exitCode=1;});
