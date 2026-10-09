import { describe,it,expect,vi } from 'vitest';
import { existsSync,writeFileSync,readFileSync } from 'node:fs';
import { Wallet,SendPending,SendPaused } from '../src/wallet.js';
import { RPC } from '../src/rpc.js';
import { Store } from '../src/ledger.js';
import { acquireLock } from '../src/lock.js';
import { config,H } from './helpers.js';
function setup(){const c=config();c.executor='live';const rpc=new RPC(c),store=rpc.store;
 const receipt={status:'success',blockHash:H(100),blockNumber:100n,transactionHash:H(1),logs:[]};
 const priority={getChainId:vi.fn(async()=>4663),getTransactionCount:vi.fn(async()=>7),getTransactionReceipt:vi.fn(async()=>{throw new Error('not found');}),sendRawTransaction:vi.fn(async()=>H(1)),waitForTransactionReceipt:vi.fn(async()=>receipt)};
 (rpc as any).priority=priority;
 const wallet=new (Wallet as any)(c,rpc,store,{address:c.launch.payoutWallet,type:'local',source:'test',signTransaction:()=>{throw new Error('unused');}}) as Wallet;
 const signer={account:{address:c.launch.payoutWallet},prepareTransactionRequest:vi.fn(async x=>x),signTransaction:vi.fn(async()=> '0x0102')};(wallet as any).client=signer;
 return {c,rpc,store,wallet,priority,signer,receipt};}
describe('durable wallet journal and writer lock',()=>{
 it('persists signed intent before broadcast and reuses its nonce on timeout',async()=>{
  const x=setup(),call={to:x.c.launch.hook,data:'0x1234' as const};
  x.priority.sendRawTransaction.mockImplementation(async()=>{const ops=x.store.read<any>('private/transactions.json',{});expect(ops.op.nonce).toBe(7);expect(ops.op.serialized).toBe('0x0102');return H(1);});
  x.priority.waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
  await expect(x.wallet.send('op',call)).rejects.toBeInstanceOf(SendPending);await x.wallet.send('op',call);expect(x.signer.signTransaction).toHaveBeenCalledTimes(1);expect(x.priority.sendRawTransaction).toHaveBeenCalledTimes(2);
  expect(x.store.read<any>('private/transactions.json',{}).op.serialized).toBeUndefined();
 });
 it('refuses operation ID reuse with changed calldata, and stops sends when paused',async()=>{
  const x=setup();await x.wallet.send('op',{to:x.c.launch.hook,data:'0x1234'});await expect(x.wallet.send('op',{to:x.c.launch.hook,data:'0x5678'})).rejects.toThrow('different calldata');
  writeFileSync(x.c.exec.pauseFile,'pause');await expect(x.wallet.send('new',{to:x.c.launch.hook,data:'0x1234'})).rejects.toBeInstanceOf(SendPaused);
 });
 it('does not echo an invalid environment secret or construct a dry-run signer',()=>{
  const c=config(),rpc=new RPC(c),old=process.env.PAYOUT_PRIVATE_KEY;process.env.PAYOUT_PRIVATE_KEY='environment-only-sensitive-value';
  try{expect(()=>Wallet.fromEnvironment(c,rpc)).toThrow('Dry-run');c.executor='live';expect(()=>Wallet.fromEnvironment(c,rpc)).toThrow('PAYOUT_PRIVATE_KEY is required');expect(existsSync(`${c.dataDir}/private/transactions.json`)).toBe(false);}finally{if(old===undefined)delete process.env.PAYOUT_PRIVATE_KEY;else process.env.PAYOUT_PRIVATE_KEY=old;}
 });
 it('kernel lock excludes a second writer and is reusable after release',async()=>{const c=config(),file=`${c.dataDir}/private/test.lock`,release=await acquireLock(file);try{await expect(acquireLock(file)).rejects.toThrow('Another writer');}finally{await release();}await (await acquireLock(file))();});
});
