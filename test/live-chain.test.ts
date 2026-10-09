import { describe,it,expect,vi } from 'vitest';
import { encodeEventTopics,encodeAbiParameters,type AbiEvent,type TransactionReceipt } from 'viem';
import { LiveChain } from '../src/executor.js';
import { RPC } from '../src/rpc.js';
import { IMD,Q96 } from '../src/config.js';
import { TOKEN_ABI } from '../src/indexer.js';
import { makeLedger,chunks } from '../src/payout.js';
import { eligibility } from '../src/eligibility.js';
import { config,H,alice,baseEvents,buyEvents,wallet } from './helpers.js';
function log(abi:any,name:string,args:Record<string,unknown>,address:string){const e=abi.find((x:any)=>x.type==='event'&&x.name===name) as AbiEvent;return {address,topics:encodeEventTopics({abi,eventName:name,args} as any),data:encodeAbiParameters(e.inputs.filter(i=>!i.indexed),e.inputs.filter(i=>!i.indexed).map(i=>args[i.name!])),blockNumber:100n,transactionHash:H(22),blockHash:H(100),logIndex:0,transactionIndex:0};}
function setup(){const c=config(),rpc=new RPC(c);const logs=[log(c.launch.abis.roundPayout,'Funded',{token:IMD,amount:100n},c.launch.roundPayout),log(TOKEN_ABI,'Transfer',{from:c.launch.payoutWallet,to:c.launch.roundPayout,value:100n},IMD)];
 const receipt={status:'success',transactionHash:H(22),blockNumber:100n,blockHash:H(100),logs} as unknown as TransactionReceipt;
 const client={getTransactionReceipt:vi.fn(async()=>receipt),getBlockNumber:vi.fn(async()=>105n),readContract:vi.fn(async()=>100n),getCode:vi.fn(async()=>undefined),getBlock:vi.fn(async()=>({number:105n,timestamp:2000n}))};(rpc as any).priority=client;
 return {c,rpc,receipt,client,chain:new LiveChain(c,rpc,{} as any)};
}
describe('real funding proof decoder and eligibility guard',()=>{
 it('requires BOTH a Funded event and exact IMD Transfer from the payout wallet',async()=>{
  const x=setup();expect(await x.chain.fundingProof(x.receipt,100n)).toBe(true);x.receipt.logs.pop();expect(await x.chain.fundingProof(x.receipt,100n)).toBe(false);
  const y=setup();y.receipt.logs.shift();expect(await y.chain.fundingProof(y.receipt,100n)).toBe(false);
 });
 it('requires a priority-node historical balance read, confirmations, and the same block hash',async()=>{
  const x=setup();x.client.readContract.mockResolvedValue(0n);expect(await x.chain.fundingProof(x.receipt,100n)).toBe(false);expect(x.client.readContract).toHaveBeenCalledWith(expect.objectContaining({blockNumber:100n,address:IMD}));
  const y=setup();y.client.getBlockNumber.mockResolvedValue(102n);expect(await y.chain.fundingProof(y.receipt,100n)).toBe(false);
  const z=setup();z.client.getTransactionReceipt.mockResolvedValue({...z.receipt,blockHash:H(999)});expect(await z.chain.fundingProof(z.receipt,100n)).toBe(false);
 });
 it('rejects funding receipts with the wrong transfer source or amount',async()=>{const x=setup();x.receipt.logs[1]=log(TOKEN_ABI,'Transfer',{from:alice,to:x.c.launch.roundPayout,value:100n},IMD) as any;expect(await x.chain.fundingProof(x.receipt,100n)).toBe(false);});
 it('checks code, balances and outgoing transfers after the index frontier',async()=>{
  const x=setup(),events=[...baseEvents(x.c),...buyEvents(x.c)];x.rpc.store.write('private/indexer.json',{events,contracts:[],head:100n});vi.spyOn(x.rpc,'logs').mockResolvedValue([]);
  const part=chunks(makeLedger(1,1900,Q96,[eligibility(wallet(),Q96,0n)],100n,0n))[0];await expect(x.chain.validateRecipients(part)).resolves.toBeUndefined();
  x.client.getCode.mockResolvedValue('0xef0100' as any);await expect(x.chain.validateRecipients(part)).rejects.toThrow('code');x.client.getCode.mockResolvedValue(undefined);
  vi.mocked(x.rpc.logs).mockResolvedValue([log(TOKEN_ABI,'Transfer',{from:alice,to:x.c.launch.router,value:1n},x.c.launch.token)] as any);await expect(x.chain.validateRecipients(part)).rejects.toThrow('outflow');
 });
});

import { encodeFunctionData } from 'viem';
it('validates IMD payRound calldata and uses a journal receipt without rescanning chain history',async()=>{
 const x=setup(),hash=H(555),args=[1000n,IMD,[alice],[100n],hash,Q96,900n];
 x.rpc.store.write('private/transactions.json',{'epoch:1:pay:0':{hash:x.receipt.transactionHash}});
 x.receipt.logs=[log(x.c.launch.abis.roundPayout,'Paid',{roundId:1000n,to:alice,amount:100n},x.c.launch.roundPayout),log(x.c.launch.abis.roundPayout,'RoundPaid',{roundId:1000n,ledgerHash:hash,twapCloseX96:Q96,totalEligibleLoss:900n},x.c.launch.roundPayout)] as any;
 const transaction={to:x.c.launch.roundPayout,from:x.c.launch.payoutWallet,input:encodeFunctionData({abi:x.c.launch.abis.roundPayout,functionName:'payRound',args} as any)};
 (x.client as any).getTransaction=vi.fn(async()=>transaction);const logs=vi.spyOn(x.rpc,'logs');
 expect(await x.chain.evidence(1000n)).toEqual({ledgerHash:hash,legs:[{to:alice,amount:100n,failed:false}]});expect(logs).not.toHaveBeenCalled();
 args[1]=x.c.launch.token;transaction.input=encodeFunctionData({abi:x.c.launch.abis.roundPayout,functionName:'payRound',args} as any);
 await expect(x.chain.evidence(1000n)).rejects.toThrow('IMD');
});

import { event } from './helpers.js';
it('retry checks current coverage and refuses recovered losses instead of blindly paying an old failed leg',async()=>{
 const x=setup(),events=[...baseEvents(x.c),...buyEvents(x.c),event(x.c,'PayFailed',{roundId:1000n,to:alice,amount:100n},3,0,3,1950)];
 x.rpc.store.write('private/indexer.json',{events,contracts:[],head:100n});vi.spyOn(x.rpc,'logs').mockResolvedValue([]);
 await expect(x.chain.validateRetry(1000n,[alice])).resolves.toBeUndefined();
 events.push(event(x.c,'Swap',{id:x.c.launch.poolId,amount0:-1n,amount1:100n,sqrtPriceX96:4n*Q96},4,0,4,1955));
 x.rpc.store.write('private/indexer.json',{events,contracts:[],head:100n});x.client.getBlock.mockResolvedValue({number:105n,timestamp:2900n});
 await expect(x.chain.validateRetry(1000n,[alice])).rejects.toThrow('loss caps');
});
