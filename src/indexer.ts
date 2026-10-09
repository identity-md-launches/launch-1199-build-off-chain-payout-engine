import { decodeEventLog, parseAbi, toEventSelector, type Address, type Hex } from 'viem';
import { IMD, exclusions, type Config, type Launch } from './config.js';
import { applyTransactions, emptyWallet, type Buy, type Transfer, type WalletLedger } from './eligibility.js';
import { priceX96, type Observation } from './twap.js';
import { RPC, HeaderCache, type RpcLog } from './rpc.js';
import { Store,ledgerHash } from './ledger.js';
import type { ClaimReceipt,WriteOffReceipt } from './fees.js';
export const TOKEN_ABI=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)','function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)','function approve(address,uint256) returns (bool)','function decimals() view returns (uint8)','function symbol() view returns (string)']);
export const POOL_ABI=parseAbi([
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
]);
export type Event={ id:string; address:Address; name:string; args:Record<string,any>; blockNumber:bigint; blockHash:Hex; transactionHash:Hex;transactionIndex:number;logIndex:number;timestamp:number };
export type Pool={currency0:Address;currency1:Address;imdIsCurrency1:boolean;initialPriceX96:bigint};
export type IndexState={version:1;chainId:number;poolId:Hex;launchIdentity:Hex;head:bigint;headHash:Hex|null;events:Event[];contracts:string[];contractBlocks?:Record<string,bigint>;lastProgressAt:number};
export type Rebuilt={wallets:Map<string,WalletLedger>;observations:Observation[];receipts:ClaimReceipt[];refunds:WriteOffReceipt[];pool:Pool;paid:Map<string,bigint>;failures:Map<string,{roundId:bigint;to:Address;amount:bigint}>};
const lower=(s:string)=>s.toLowerCase();
const amount=(v:any,name:string)=>{if(typeof v!=='bigint'&&typeof v!=='number')throw new Error(`Missing event field ${name}`);return BigInt(v);};
export const eventOrder=(a:Event,b:Event)=>a.blockNumber<b.blockNumber?-1:a.blockNumber>b.blockNumber?1:a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex;
export function groupTransactions(events:readonly Event[]):Event[][] {
  const groups=new Map<string,Event[]>();
  for(const event of [...events].sort(eventOrder)) {
    const key=`${event.blockHash}:${event.transactionHash}`;
    const group=groups.get(key)||[];group.push(event);groups.set(key,group);
  }
  return [...groups.values()];
}
export function readPool(events:readonly Event[],launch:Launch):Pool {
  const logs=events.filter(e=>e.name==='Initialize'&&lower(e.address)===lower(launch.poolManager)&&lower(e.args.id)===lower(launch.poolId));
  if(logs.length!==1)throw new Error('Expected exactly one pool Initialize');
  const a=logs[0].args,c0=lower(a.currency0) as Address,c1=lower(a.currency1) as Address;
  if(![c0,c1].includes(lower(IMD) as Address)||![c0,c1].includes(lower(launch.token) as Address)||lower(a.hooks)!==lower(launch.hook))throw new Error('Initialize does not match launch token, IMD and hook');
  if(amount(a.fee,'fee')!==12500n)throw new Error('Unexpected LP fee; expected 1.25%');
  return {currency0:c0,currency1:c1,imdIsCurrency1:c1===lower(IMD),initialPriceX96:priceX96(amount(a.sqrtPriceX96,'sqrtPriceX96'),c1===lower(IMD))};
}
export function transactionInputs(group:readonly Event[],pool:Pool,c:Config,contracts:Set<string>):{transfers:Transfer[];buys:Buy[]} {
  const l=c.launch;
  const transfers=group.filter(e=>e.name==='Transfer'&&lower(e.address)===lower(l.token)).map(e=>({from:lower(e.args.from) as Address,to:lower(e.args.to) as Address,amount:amount(e.args.value,'value'),logIndex:e.logIndex}));
  const swaps=group.filter(e=>e.name==='Swap'&&lower(e.address)===lower(l.poolManager)&&lower(e.args.id)===lower(l.poolId));
  const fees=group.filter(e=>e.name==='FeeAccrued'&&lower(e.address)===lower(l.hook));
  const buySwaps=swaps.filter(s=>amount(s.args[pool.imdIsCurrency1?'amount0':'amount1'],'tokenDelta')>0n);
  const buyFees=fees.filter(f=>f.args.isSell===false);
  const buys:Buy[]=[];
  // Fee-free buys remain zero-basis. A partially decoded/mismatched hooked transaction must stop the indexer.
  if(buyFees.length && buyFees.length!==buySwaps.length)throw new Error('Ambiguous buy/FeeAccrued pairing');
  for(let i=0;i<buyFees.length;i++) {
    const s=buySwaps[i],f=buyFees[i],tokens=amount(s.args[pool.imdIsCurrency1?'amount0':'amount1'],'tokenDelta');
    const imd=amount(s.args[pool.imdIsCurrency1?'amount1':'amount0'],'imdDelta');
    if(imd>=0n)throw new Error('Buy has no IMD input');
    const base=amount(f.args.baseFeeImd,'baseFeeImd'),surcharge=amount(f.args.surchargeImd,'surchargeImd');
    if(base<0n||surcharge<0n)throw new Error('Negative hook fee');
    // v4's core Swap delta includes LP fees; the hook's separately accrued delta is added once.
    buys.push({tokens,cost:-imd+base+surcharge,feePaid:base+surcharge});
  }
  return {transfers,buys};
}
export function rebuild(events:readonly Event[],c:Config,contracts:ReadonlySet<string>=new Set(),untilBlock?:bigint):Rebuilt {
  const sorted=[...events].filter(e=>untilBlock===undefined||e.blockNumber<=untilBlock).sort(eventOrder);
  const pool=readPool(sorted,c.launch),excluded=exclusions(c),contractSet=new Set([...contracts].map(lower));
  const groups=groupTransactions(sorted);
  const wallets=applyTransactions(new Map(),groups.map(group=>({...transactionInputs(group,pool,c,contractSet),poolManager:c.launch.poolManager,excluded,contracts:contractSet})));
  const observations:Observation[]=[],receipts:ClaimReceipt[]=[],refunds:WriteOffReceipt[]=[];
  const paid=new Map<string,bigint>(),failures=new Map<string,{roundId:bigint;to:Address;amount:bigint}>();
  const unique=new Set<string>();
  for(const group of groups) {
    for(const e of group) {if(unique.has(e.id))throw new Error('Duplicate indexed event');unique.add(e.id);}
    let swept=0n,received=0n;
    for(const e of group) {
      const a=e.args;
      if(e.name==='Initialize'&&lower(e.address)===lower(c.launch.poolManager)&&lower(a.id)===lower(c.launch.poolId))
        observations.push({timestamp:e.timestamp,priceX96:pool.initialPriceX96,blockNumber:e.blockNumber,logIndex:e.logIndex});
      if(e.name==='Swap'&&lower(e.address)===lower(c.launch.poolManager)&&lower(a.id)===lower(c.launch.poolId))
        observations.push({timestamp:e.timestamp,priceX96:priceX96(amount(a.sqrtPriceX96,'sqrtPriceX96'),pool.imdIsCurrency1),blockNumber:e.blockNumber,logIndex:e.logIndex});
      if(e.name==='Swept'&&lower(e.address)===lower(c.launch.hook)&&lower(a.to)===lower(c.launch.payoutWallet)) {
        const n=amount(a.imdAmount,'imdAmount');swept+=n;
        receipts.push({id:e.id,kind:'sweep',amount:n,blockNumber:e.blockNumber,timestamp:e.timestamp,transactionHash:e.transactionHash});
      }
      if(e.name==='Transfer'&&lower(e.address)===lower(IMD)&&lower(a.to)===lower(c.launch.payoutWallet)) {
        const n=amount(a.value,'value');if([lower(c.launch.hook),lower(c.launch.poolManager)].includes(lower(a.from)))received+=n;
        if(lower(a.from)===lower(c.launch.distributor))receipts.push({id:e.id,kind:'distributor',amount:n,blockNumber:e.blockNumber,timestamp:e.timestamp,transactionHash:e.transactionHash});
      }
      if(lower(e.address)===lower(c.launch.roundPayout)) {
        if(e.name==='Paid') {
          const to=lower(a.to) as Address,n=amount(a.amount,'amount');paid.set(to,(paid.get(to)||0n)+n);
          failures.delete(`${a.roundId}:${to}`);
        } else if(e.name==='PayFailed') {
          const to=lower(a.to) as Address;failures.set(`${a.roundId}:${to}`,{roundId:amount(a.roundId,'roundId'),to,amount:amount(a.amount,'amount')});
        } else if(e.name==='WrittenOff'){const key=`${a.roundId}:${lower(a.to)}`,failed=failures.get(key);if(failed)refunds.push({id:e.id,roundId:failed.roundId,to:failed.to,amount:failed.amount,blockNumber:e.blockNumber});failures.delete(key);}
      }
    }
    if(swept>received)throw new Error('Sweep lacks matching IMD inflow');
  }
  for(const [a,n] of paid){const w=wallets.get(a)||emptyWallet(a as Address);w.paid=n;wallets.set(a,w);}
  for(const f of failures.values()){const w=wallets.get(f.to)||emptyWallet(f.to);w.reserved+=f.amount;wallets.set(f.to,w);}
  return {wallets,observations,receipts,refunds,pool,paid,failures};
}
export function decodeLog(log:RpcLog,l:Launch,timestamp:number):Event|null {
  let abi:any;
  const a=lower(log.address);
  if(a===lower(l.token)||a===lower(IMD))abi=TOKEN_ABI;
  else if(a===lower(l.poolManager))abi=POOL_ABI;
  else if(a===lower(l.hook))abi=l.abis.hook;
  else if(a===lower(l.roundPayout))abi=l.abis.roundPayout;
  else return null;
  let decoded:any;
  try{decoded=decodeEventLog({abi,data:log.data,topics:log.topics as any,strict:true});}catch{if(abi.some((e:any)=>e.type==='event'&&toEventSelector(e)===log.topics[0]))throw new Error('Malformed expected event or incorrect indexed ABI fields');return null;}
  if(a===lower(l.poolManager)&&lower(decoded.args.id||'')!==lower(l.poolId))return null;
  if(a===lower(IMD)&&decoded.eventName==='Transfer'&&lower(decoded.args.to)!==lower(l.payoutWallet))return null;
  return {id:`${log.blockHash}:${log.transactionHash}:${log.logIndex}`,address:log.address,name:decoded.eventName,args:decoded.args,
    blockNumber:log.blockNumber,blockHash:log.blockHash,transactionHash:log.transactionHash,transactionIndex:log.transactionIndex,logIndex:log.logIndex,timestamp};
}
export class Indexer {
  state:IndexState;readonly headers:HeaderCache;
  constructor(readonly c:Config,readonly rpc:RPC,readonly store:Store=rpc.store) {
    const l=c.launch,launchIdentity=ledgerHash({chainId:l.chainId,token:l.token,poolManager:l.poolManager,poolId:l.poolId,hook:l.hook,distributor:l.distributor,router:l.router,roundPayout:l.roundPayout,payoutWallet:l.payoutWallet,deployer:l.deployer,factory:l.factory,launchBlock:l.launchBlock,launchTs:l.launchTs,tokenDecimals:l.tokenDecimals});
    this.state=store.read('private/indexer.json',{version:1,chainId:c.launch.chainId,poolId:c.launch.poolId,launchIdentity,head:c.launch.launchBlock-1n,headHash:null,events:[],contracts:[],lastProgressAt:Date.now()});
    if(this.state.chainId!==c.launch.chainId||this.state.poolId!==c.launch.poolId||this.state.launchIdentity!==launchIdentity)throw new Error('Data directory belongs to another launch');
    this.headers=new HeaderCache(rpc);
  }
  async sync(head:bigint,pinned?:any):Promise<void> {
    if(this.state.headHash) {
      const current=await this.headers.exact(this.state.head,pinned,true);
      if(current.hash!==this.state.headHash)throw new Error('Indexed chain reorganized: pause and replay before resuming');
    }
    const l=this.c.launch;
    for(let start=this.state.head+1n;start<=head;start+=this.c.rpc.logChunk) {
      const stop=start+this.c.rpc.logChunk-1n,end=stop<head?stop:head;
      const endBefore=await this.headers.exact(end,pinned,true);
      const filters=[
        {address:l.token,event:TOKEN_ABI[0]},
        {address:l.poolManager,event:POOL_ABI[0],args:{id:l.poolId}},
        {address:l.poolManager,event:POOL_ABI[1],args:{id:l.poolId}},
        {address:l.hook}, {address:IMD,event:TOKEN_ABI[0],args:{to:l.payoutWallet}}, {address:l.roundPayout},
      ];
      const batches=await Promise.all(filters.map(filter=>this.rpc.logs(filter,start,end,pinned)));
      const raw=batches.flat().sort((a,b)=>a.blockNumber<b.blockNumber?-1:a.blockNumber>b.blockNumber?1:a.logIndex-b.logIndex);
      const events:Event[]=[];const contracts=new Set(this.state.contracts);const contractBlocks={...this.state.contractBlocks};const checked=new Set<string>();
      for(const log of raw) {
        const timestamp=await this.headers.timestamp(log.blockNumber,head,pinned),e=decodeLog(log,l,timestamp);if(!e)continue;
        events.push(e);
        if(e.name==='Transfer'&&lower(e.address)===lower(l.token)) {
          for(const addr of [lower(e.args.from),lower(e.args.to)]) {
            if(checked.has(addr)||contracts.has(addr)||exclusions(this.c).has(addr))continue;
            const get=(client:any)=>client.getCode({address:addr,blockNumber:log.blockNumber});
            const code=pinned?await get(pinned):await this.rpc.read(get);if(code&&code!=='0x'){contracts.add(addr);contractBlocks[addr]??=log.blockNumber;}checked.add(addr);
          }
        }
      }
      const after=await this.headers.exact(end,pinned,true);
      if(after.hash!==endBefore.hash)throw new Error('Chain changed while indexing');
      const logNodeHeader=await (pinned||this.rpc.logsClient).getBlock({blockNumber:end});
      if(logNodeHeader.hash!==after.hash)throw new Error('Log RPC is on a different fork');
      for(const e of events){const cached=this.headers.peek(e.blockNumber);if(cached&&cached.hash!==e.blockHash)throw new Error('Log/header fork mismatch');}
      const merged=[...this.state.events,...events];
      if(events.some(e=>e.name==='Initialize'))readPool(merged,this.c.launch);
      this.state={...this.state,head:end,headHash:after.hash,events:merged,contracts:[...contracts].sort(),contractBlocks,lastProgressAt:Date.now()};
      this.headers.flush();this.store.write('private/indexer.json',this.state);
    }
  }
  rebuild(untilBlock?:bigint):Rebuilt{return rebuild(this.state.events,this.c,new Set(this.state.contracts.filter(a=>untilBlock===undefined||(this.state.contractBlocks?.[a]??this.c.launch.launchBlock)<=untilBlock)),untilBlock);}
  async markContracts(addresses:readonly Address[],blockNumber:bigint,client:any):Promise<void> {
    const known=new Set(this.state.contracts);this.state.contractBlocks??={};
    for(const address of addresses){const code=await client.getCode({address,blockNumber});if(code&&code!=='0x'){known.add(lower(address));this.state.contractBlocks[lower(address)]??=blockNumber;}}
    this.state.contracts=[...known].sort();this.store.write('private/indexer.json',this.state);
  }
}
