import { describe,it,expect,vi } from 'vitest';
import { fixtureInput,compareLedgers } from '../scripts/replay.js';
import { RoundRunner,replayEvents } from '../src/rounds.js';
import { rebuild } from '../src/indexer.js';
import { Store } from '../src/ledger.js';
import { Executor } from '../src/executor.js';
import { SendPending } from '../src/wallet.js';
import { IMD,Q96 } from '../src/config.js';
import { config,temp,baseEvents,buyEvents,event,alice,H } from './helpers.js';
function setup(){
 const f=fixtureInput('test/fixtures/replay.json'),c=f.config;c.dataDir=temp();c.exec.pauseFile=`${c.dataDir}/PAUSE`;
 const store=new Store(c.dataDir),alerts={send:vi.fn(async()=>{})};
 const rpc={store,safeHead:vi.fn(async()=>20n),priority:{getBlockNumber:vi.fn(async()=>20n)}};
 const indexer={state:{events:f.events,contracts:[],head:20n,lastProgressAt:Date.now()},sync:vi.fn(async()=>{}),
   headers:{exact:vi.fn(async()=>({number:20n,timestamp:3700n,hash:H(20)})),before:vi.fn(async(ts:number)=>f.events.filter(e=>e.timestamp<ts).reduce((m,e)=>e.blockNumber>m?e.blockNumber:m,0n))},
   rebuild:(block?:bigint)=>rebuild(f.events,c,new Set(),block),markContracts:vi.fn(async()=>{})};
 const executor=new Executor(c,undefined,store,alerts);
 return {c,store,alerts,rpc,indexer,executor,runner:new RoundRunner(c,rpc as any,indexer as any,executor,alerts as any,undefined,store)};
}
describe('round orchestration and restart',()=>{
 it('backfills three epochs once and exposes a next-drop view without a signer',async()=>{
  const x=setup();expect(await x.runner.tick()).toBe(true);expect(await x.runner.tick()).toBe(true);expect(await x.runner.tick()).toBe(true);expect(await x.runner.tick()).toBe(false);
  expect(x.runner.state.rounds.map(r=>r.amount)).toEqual([449n,102n,149n]);expect(x.runner.state.simulatedPaid[alice]).toBe(556n);
  const view=x.store.read<any>('private/view.json',null);expect(view.nextEpoch).toBe(4);expect(view.nextDropAt).toBe(4600);expect(view.treasury.pot).toBe(0n);
  const again=new RoundRunner(x.c,x.rpc as any,x.indexer as any,x.executor,x.alerts as any,undefined,x.store);expect(await again.tick()).toBe(false);expect(again.state.rounds).toHaveLength(3);
 });
 it('resumes an immutable prepared intent after a crash, without double-booking receipts',async()=>{
  const x=setup(),execute=vi.spyOn(x.executor,'execute').mockRejectedValueOnce(new SendPending());
  await expect(x.runner.tick()).rejects.toBeInstanceOf(SendPending);expect(x.runner.state.completedEpoch).toBe(0);expect(x.runner.state.intent!.ledger.pot).toBe(450n);
  const restarted=new RoundRunner(x.c,x.rpc as any,x.indexer as any,x.executor,x.alerts as any,undefined,x.store);await restarted.tick();expect(restarted.state.treasury.pot).toBe(1n);expect(restarted.state.rounds).toHaveLength(1);expect(restarted.state.simulatedPaid[alice]).toBe(305n);
 });
 it('never carries dry-run simulated payments into live state',()=>{const x=setup();x.store.write('private/engine.json',x.runner.state);x.c.executor='live';expect(()=>new RoundRunner(x.c,x.rpc as any,x.indexer as any,x.executor,x.alerts as any)).toThrow('separate DATA_DIR');});
 it('replay uses actual Paid events instead of double-counting them as simulated payments',()=>{
  const c=config(),logs=[...baseEvents(c),...buyEvents(c,alice,2,true,100n,950n,50n)];logs.forEach(e=>{if(e.blockNumber===2n)e.timestamp=1100;});
  logs.push(event(c,'Swept',{imdAmount:900n,to:c.launch.payoutWallet},3,0,3,1500));
  const transfer=event(c,'Transfer',{from:c.launch.poolManager,to:c.launch.payoutWallet,value:900n},3,1,3,1500);transfer.address=IMD;logs.push(transfer);
  for(const [epoch,block,time] of [[1,4,2000],[2,5,2900]])logs.push(event(c,'Paid',{roundId:BigInt(epoch*1000),to:alice,amount:300n},block,0,block,time),event(c,'RoundPaid',{roundId:BigInt(epoch*1000),ledgerHash:H(epoch),twapCloseX96:Q96,totalEligibleLoss:900n},block,1,block,time));
  const replay=replayEvents(logs,c,3);expect(replay.map(l=>l.payees[0]?.amount)).toEqual([300n,300n,300n]);
 });
});

import { Indexer } from '../src/indexer.js';
import { RPC } from '../src/rpc.js';
it('starts the stall timer at startup, then alerts when the configured idle interval elapses',async()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValue(1_000_000);
 try{const c=config(),rpc=new RPC(c),indexer=new Indexer(c,rpc),alerts={send:vi.fn(async()=>{})};const executor=new Executor(c,undefined,rpc.store,alerts),runner=new RoundRunner(c,rpc,indexer,executor,alerts as any);
  await runner.monitor();expect(alerts.send).not.toHaveBeenCalled();clock.mockReturnValue(1_301_000);await runner.monitor();expect(alerts.send).toHaveBeenCalledWith('stalled',expect.anything());
 }finally{clock.mockRestore();}
});
