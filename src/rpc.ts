import { createPublicClient, http, defineChain, type Hex, type Address } from 'viem';
import type { Config } from './config.js';
import { CHAIN_ID, RULES } from './config.js';
import { Store } from './ledger.js';
export const chain=defineChain({id:CHAIN_ID,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[]}}});
export type RpcLog={address:Address;data:Hex;topics:readonly Hex[];blockNumber:bigint;blockHash:Hex;transactionHash:Hex;transactionIndex:number;logIndex:number;removed?:boolean};
export type Header={number:bigint;timestamp:bigint;hash:Hex;parentHash:Hex};
export type LogFilter={address?:Address|Address[];event?:any;events?:any[];args?:any;strict?:boolean};
export const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export class RpcUnavailable extends Error { constructor(message='RPC unavailable; retry without changing round state'){super(message);this.name='RpcUnavailable';} }
export class RPC {
  readonly clients:any[];readonly logsClient:any;readonly priority:any;
  private cursor=0;private cooldown:number[];private failures:number[];
  constructor(readonly c:Config,readonly store=new Store(c.dataDir)) {
    const client=(url:string)=>createPublicClient({chain,transport:http(url,{retryCount:0,timeout:c.rpc.timeoutMs}),pollingInterval:c.rpc.pollMs});
    this.clients=c.rpc.urls.map(client);this.logsClient=client(c.rpc.logsUrl);this.priority=client(c.rpc.priorityUrl);
    this.cooldown=this.clients.map(()=>0);this.failures=this.clients.map(()=>0);
  }
  async validate():Promise<void> {
    const clients=[...this.clients,this.priority,this.logsClient];
    for(const client of clients)if(await client.getChainId()!==CHAIN_ID)throw new Error('RPC chain ID mismatch');
  }
  async read<T>(fn:(client:any)=>Promise<T>):Promise<T> {
    for(let tries=0;tries<this.clients.length;tries++) {
      const i=this.cursor++%this.clients.length;if(this.cooldown[i]>Date.now())continue;
      try {const result=await fn(this.clients[i]);this.failures[i]=0;return result;}
      catch {this.failures[i]++;this.cooldown[i]=Date.now()+Math.min(30000,this.c.rpc.backoffMs*2**Math.min(this.failures[i]-1,5));}
    }
    throw new RpcUnavailable();
  }
  /** All endpoints must answer. Dropping an unavailable/lagging endpoint could move the safe head forwards. */
  async safeHead():Promise<bigint> {
    const values=await Promise.all(this.clients.map(async client=>BigInt(await client.getBlockNumber({cacheTime:0}))));
    const low=values.reduce((a,b)=>a<b?a:b);
    return low>this.c.rpc.followMargin?low-this.c.rpc.followMargin:0n;
  }
  async logs(filter:LogFilter,from:bigint,to:bigint,pinned?:any):Promise<RpcLog[]> {
    if(from>to)return [];
    const client=pinned||this.logsClient;
    const range=async(a:bigint,b:bigint):Promise<RpcLog[]>=>{
      try {const logs=await client.getLogs({...filter,fromBlock:a,toBlock:b});
        if(logs.some((l:any)=>l.removed||l.blockNumber==null||l.transactionHash==null||l.logIndex==null))throw new RpcUnavailable('Incomplete logs');
        return logs as RpcLog[];
      } catch {if(a===b)throw new RpcUnavailable('A single-block log range failed');
        const mid=(a+b)/2n;return [...await range(a,mid),...await range(mid+1n,b)];}
    };
    const all:RpcLog[]=[];
    for(let start=from;start<=to;start+=this.c.rpc.logChunk) {
      const end=start+this.c.rpc.logChunk-1n;
      all.push(...await range(start,end<to?end:to));
    }
    return all;
  }
}
export class HeaderCache {
  private headers:Record<string,Header>;
  constructor(readonly rpc:RPC){this.headers=rpc.store.read('private/headers.json',{});}
  async exact(block:bigint,pinned?:any,refresh=false):Promise<Header> {
    const key=block.toString();
    if(!refresh&&this.headers[key])return this.headers[key];
    const get=async(c:any)=>{
      const b=await c.getBlock({blockNumber:block});
      if(!b.hash||b.number!==block)throw new RpcUnavailable('Missing block');
      return {number:b.number,timestamp:b.timestamp,hash:b.hash,parentHash:b.parentHash} as Header;
    };
    const b=pinned?await get(pinned):await this.rpc.read(get);this.headers[key]=b;return b;
  }
  async timestamp(block:bigint,head:bigint,pinned?:any):Promise<number> {
    const spacing=this.rpc.c.rpc.anchorSpacing,low=block/spacing*spacing;
    let high=low+spacing;if(high>head)high=head;
    const [a,b]=await Promise.all([this.exact(low,pinned),this.exact(high,pinned)]);
    if(a.timestamp>b.timestamp)throw new RpcUnavailable('Non-monotonic headers');
    const launch=this.rpc.c.launch.launchTs;
    const crosses=(offset:number)=>(Number(a.timestamp)-launch-offset)%RULES.epochSeconds===0||Math.floor((Number(a.timestamp)-launch-offset)/RULES.epochSeconds)!==Math.floor((Number(b.timestamp)-launch-offset)/RULES.epochSeconds);
    // Every event in an anchor interval that touches either boundary uses its exact header.
    if(block===low||block===high||crosses(0)||crosses(-RULES.twapSeconds))return Number((await this.exact(block,pinned)).timestamp);
    return Number(a.timestamp+(b.timestamp-a.timestamp)*(block-low)/(high-low));
  }
  async before(timestamp:number,head:bigint,pinned?:any):Promise<bigint> {
    let lo=this.rpc.c.launch.launchBlock,hi=head,answer=lo-1n;
    while(lo<=hi) {const mid=(lo+hi)/2n,b=await this.exact(mid,pinned);if(Number(b.timestamp)<timestamp){answer=mid;lo=mid+1n;}else hi=mid-1n;}
    return answer;
  }
  peek(block:bigint):Header|undefined{return this.headers[block.toString()];}
  flush(){this.rpc.store.write('private/headers.json',this.headers);}
  clear(){this.headers={};this.flush();}
}
