import { describe,it,expect,vi } from 'vitest';
import { RPC,HeaderCache,RpcUnavailable } from '../src/rpc.js';
import { config,H } from './helpers.js';
describe('RPC selection and logs',()=>{
  it('uses lowest head, requires all endpoints, and subtracts margin',async()=>{
    const rpc=new RPC(config());(rpc as any).clients=[{getBlockNumber:async()=>100n},{getBlockNumber:async()=>90n}];expect(await rpc.safeHead()).toBe(70n);
    (rpc as any).clients[1].getBlockNumber=async()=>{throw new Error('offline');};await expect(rpc.safeHead()).rejects.toThrow();
  });
  it('round robin backs off a failing endpoint',async()=>{
    const rpc=new RPC(config());(rpc as any).clients=[{id:0},{id:1}];(rpc as any).cooldown=[0,0];(rpc as any).failures=[0,0];
    expect(await rpc.read(async c=>c.id)).toBe(0);expect(await rpc.read(async c=>c.id)).toBe(1);
    const fn=vi.fn(async(c:any)=>{if(c.id===0)throw new Error();return c.id;});expect(await rpc.read(fn)).toBe(1);expect(fn).toHaveBeenCalledTimes(2);
  });
  it('bisects refused ranges and uses the pinned client inside a round',async()=>{
    const c=config();c.rpc.logChunk=4n;const rpc=new RPC(c),seen:any[]=[];
    const pinned={getLogs:vi.fn(async({fromBlock,toBlock}:any)=>{seen.push([fromBlock,toBlock]);if(toBlock-fromBlock>1n)throw new Error('too wide');return [{blockNumber:fromBlock,transactionHash:H(1),logIndex:Number(fromBlock)}];})};
    const logs=await rpc.logs({},1n,5n,pinned);expect(logs.map(l=>l.blockNumber)).toEqual([1n,3n,5n]);expect(seen).toEqual([[1n,4n],[1n,2n],[3n,4n],[5n,5n]]);
    await expect(rpc.logs({},1n,1n,{getLogs:async()=>{throw new Error();}})).rejects.toBeInstanceOf(RpcUnavailable);
  });
  it('interpolates distant blocks but fetches exact epoch and TWAP boundary intervals',async()=>{
    const c=config();c.launch.launchTs=1000;const rpc=new RPC(c);const getBlock=vi.fn(async({blockNumber}:any)=>({number:blockNumber,timestamp:1000n+blockNumber,hash:H(Number(blockNumber)),parentHash:H(Number(blockNumber-1n))}));
    const cache=new HeaderCache(rpc),pinned={getBlock};expect(await cache.timestamp(50n,1000n,pinned)).toBe(1050);expect(getBlock.mock.calls.map(x=>x[0].blockNumber)).toEqual([0n,100n,50n]);
    getBlock.mockClear();expect(await cache.timestamp(150n,1000n,pinned)).toBe(1150);expect(getBlock.mock.calls.map(x=>x[0].blockNumber)).toEqual([200n]);
    expect(await cache.timestamp(719n,1000n,pinned)).toBe(1719);expect(getBlock.mock.calls.some(x=>x[0].blockNumber===719n)).toBe(true);
    expect(await cache.timestamp(899n,1000n,pinned)).toBe(1899);expect(getBlock.mock.calls.some(x=>x[0].blockNumber===899n)).toBe(true);
    expect(await cache.before(1900,1000n,pinned)).toBe(899n);cache.flush();
  });
});
