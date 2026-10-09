import { describe,it,expect,vi } from 'vitest';
import { usdPrices,ethUsd,publishSnapshots,noPrices } from '../src/snapshot.js';
import { walletResponse,createAPI } from '../src/api.js';
import { Store } from '../src/ledger.js';
import { Q96 } from '../src/config.js';
import { emptyTreasury } from '../src/fees.js';
import type { EngineView } from '../src/rounds.js';
import { config,alice,bob,wallet } from './helpers.js';
const view=():EngineView=>({mode:'dry-run',head:100n,headTimestamp:1800,lastProgressAt:Date.now(),nextEpoch:1,nextDropAt:1900,closeX96:Q96,spotX96:Q96,wallets:[wallet(),wallet(bob)],treasury:{...emptyTreasury(),pot:100n},rounds:[],skipped:[],stalled:false,intentEpoch:null});
describe('display snapshots and wallet API',()=>{
  it('prices IMD/token from ETH spot with decimal normalization, solely for display',()=>{const p=usdPrices(2000,1000n*Q96,2n*Q96,18,18,'test','now');expect(p.imdUsd).toBe(2);expect(p.tokenUsd).toBe(4);expect(()=>usdPrices(0,1n,1n,18,18,'','')).toThrow();});
  it('falls back from CoinGecko to Dexscreener and refuses bad prices',async()=>{
    const c=config();c.prices.dexScreenerUrl='http://fixture.invalid';const fetcher=vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValueOnce({ok:true,json:async()=>({pairs:[{baseToken:{symbol:'WETH'},priceUsd:'2100'}]})});
    expect(await ethUsd(c,fetcher as any)).toEqual({value:2100,source:'Dexscreener'});await expect(ethUsd(c,vi.fn().mockResolvedValue({ok:false}) as any)).rejects.toThrow();
  });
  it('wallet estimates use the SAME eligible population, caps and split as the engine',()=>{const c=config(),v=view();expect(walletResponse(c,v,alice).nextDropEstimate).toBe(50n);v.wallets[0].disqualified=true;expect(walletResponse(c,v,alice).eligible).toBe(false);expect(walletResponse(c,v,bob).nextDropEstimate).toBe(100n);});
  it('writes all public JSON with decimal bigint strings and never publishes internal receipt IDs',()=>{
    const c=config(),store=new Store(c.dataDir);publishSnapshots(c,store,view(),noPrices());const status=store.read<any>('status.json',null);expect(status.prices.imdUsd).toBe(null);expect(status.wouldPay).toHaveLength(2);expect(store.read<any>('treasury.json',{}).booked).toBeUndefined();
  });
  it('serves only public snapshots and never exposes journals or traversal paths',()=>{
    const c=config(),store=new Store(c.dataDir);store.write('private/view.json',view());store.write('private/transactions.json',{secret:'not-public'});publishSnapshots(c,store,view(),noPrices());
    const api=createAPI(c,store);
    const request=(url:string,method='GET')=>{let code=0,body='';api.emit('request',{method,url} as any,{writeHead:(n:number)=>{code=n;},end:(s:string)=>{body=s;}} as any);return {code,body};};
    expect(request('/api/status').code).toBe(200);expect(JSON.parse(request(`/api/wallet/${alice}`).body).nextDropEstimate).toBe('50');
    for(const path of ['/data/private/transactions.json','/data/%2e%2e/private/transactions.json','/data/.env','/data/ledgers/../../private/transactions.json'])expect(request(path).code).toBe(404);
    expect(request('/api/status','POST').code).toBe(405);api.close();
  });

});
