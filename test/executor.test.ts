import { describe,it,expect,vi } from 'vitest';
import { writeFileSync,unlinkSync } from 'node:fs';
import { type Address,type TransactionReceipt } from 'viem';
import { Executor,FundingPending,type ExecutorChain,type Evidence } from '../src/executor.js';
import { makeLedger,chunks,type Chunk } from '../src/payout.js';
import { eligibility } from '../src/eligibility.js';
import { Store } from '../src/ledger.js';
import { Q96 } from '../src/config.js';
import { SendPaused,SendPending } from '../src/wallet.js';
import { config,alice,bob,wallet,H } from './helpers.js';
function setup(){
  const c=config();c.executor='live';c.rules.maxRecipientsPerTx=1;
  const store=new Store(c.dataDir),alerts={send:vi.fn().mockResolvedValue(undefined)};
  const ledger=makeLedger(1,1900,Q96,[eligibility(wallet(),Q96,0n),eligibility(wallet(bob),Q96,0n)],200n,0n);
  const paid=new Map<bigint,Chunk>(),failureMap=new Map<string,bigint>();
  const receipt={status:'success',transactionHash:H(900),blockHash:H(100),blockNumber:100n,logs:[]} as unknown as TransactionReceipt;
  let balance=0n,proof=true;
  const chain:ExecutorChain={paused:vi.fn(async()=>false),isPaid:vi.fn(async id=>paid.has(id)),evidence:vi.fn(async id=>{
    const p=paid.get(id)!;return {ledgerHash:p.ledgerHash,legs:p.payees.map(p=>({to:p.payee,amount:p.amount,failed:false}))};
  }),balance:vi.fn(async()=>balance),fund:vi.fn(async n=>{balance+=n;return receipt;}),fundingProof:vi.fn(async()=>proof),
    pay:vi.fn(async (p:Chunk)=>{paid.set(p.roundId,p);balance-=p.payees.reduce((s,x)=>s+x.amount,0n);}),failed:vi.fn(async(id,to)=>failureMap.get(`${id}:${to}`)||0n),
    retry:vi.fn(async()=>{}),writeOff:vi.fn(async(id,to)=>{failureMap.delete(`${id}:${to}`);})};
  const executor=new Executor(c,chain,store,alerts);
  return {c,store,chain,executor,ledger,paid,receipt,alerts,failureMap,setProof:(v:boolean)=>{proof=v;},setBalance:(v:bigint)=>{balance=v;}};
}
describe('executor recovery and funding state machine',()=>{
  it('requires funding receipt proof before paying',async()=>{
    const x=setup();x.setProof(false);await expect(x.executor.execute(x.ledger)).rejects.toBeInstanceOf(FundingPending);expect(x.chain.pay).not.toHaveBeenCalled();expect(x.chain.fund).toHaveBeenCalledTimes(1);
    x.setProof(true);const restarted=new Executor(x.c,x.chain,x.store,x.alerts);await restarted.execute(x.ledger);expect(x.chain.fund).toHaveBeenCalledTimes(1);expect(x.chain.pay).toHaveBeenCalledTimes(2);
  });
  it('lagging-node zero balance stalls, does not mark failure or refund again',async()=>{
    const x=setup();vi.mocked(x.chain.balance).mockResolvedValueOnce(0n);
    await expect(x.executor.execute(x.ledger)).rejects.toBeInstanceOf(FundingPending);expect(x.chain.pay).not.toHaveBeenCalled();expect(x.alerts.send).not.toHaveBeenCalled();
    await new Executor(x.c,x.chain,x.store,x.alerts).execute(x.ledger);expect(x.chain.fund).toHaveBeenCalledTimes(1);expect(x.chain.pay).toHaveBeenCalledTimes(2);
  });
  it('re-checks isPaid immediately before every send',async()=>{
    const x=setup(),parts=chunks(x.ledger,1);let calls=0;
    vi.mocked(x.chain.isPaid).mockImplementation(async id=>{calls++;if(calls===3){x.paid.set(id,parts.find(p=>p.roundId===id)!);}return x.paid.has(id);});
    await x.executor.execute(x.ledger);expect(x.chain.pay).toHaveBeenCalledTimes(1);expect(vi.mocked(x.chain.isPaid).mock.calls.length).toBeGreaterThanOrEqual(5);
  });
  it('resumes after a mined pay whose client timed out, without repeating payment',async()=>{
    const x=setup();const normal=x.chain.pay;
    vi.mocked(x.chain.pay).mockImplementationOnce(async p=>{x.paid.set(p.roundId,p);throw new SendPending();});
    await expect(x.executor.execute(x.ledger)).rejects.toBeInstanceOf(SendPending);
    vi.mocked(x.chain.pay).mockImplementation(async p=>{x.paid.set(p.roundId,p);});
    await new Executor(x.c,x.chain,x.store,x.alerts).execute(x.ledger);expect(x.chain.pay).toHaveBeenCalledTimes(2);expect(x.chain.fund).toHaveBeenCalledTimes(1);
  });
  it('checks pause file before funding and between chunks',async()=>{
    const x=setup();writeFileSync(x.c.exec.pauseFile,'pause');await expect(x.executor.execute(x.ledger)).rejects.toBeInstanceOf(SendPaused);expect(x.chain.fund).not.toHaveBeenCalled();unlinkSync(x.c.exec.pauseFile);
    vi.mocked(x.chain.pay).mockImplementationOnce(async p=>{x.paid.set(p.roundId,p);writeFileSync(x.c.exec.pauseFile,'pause');});
    await expect(x.executor.execute(x.ledger)).rejects.toBeInstanceOf(SendPaused);expect(x.chain.pay).toHaveBeenCalledTimes(1);
  });
  it('honors contract paused and refuses absurd rounds before any send',async()=>{
    const x=setup();vi.mocked(x.chain.paused).mockResolvedValue(true);await expect(x.executor.execute(x.ledger)).rejects.toBeInstanceOf(SendPaused);
    const y=setup();y.c.exec.maxRoundPayoutQuote=199n;await expect(y.executor.execute(y.ledger)).rejects.toThrow('maximum');expect(y.chain.fund).not.toHaveBeenCalled();expect(y.alerts.send).toHaveBeenCalledWith('refused',expect.anything());
  });
  it('dry-run never constructs/calls a chain signer',async()=>{const x=setup();x.c.executor='dry-run';await new Executor(x.c,undefined,x.store,x.alerts).execute(x.ledger);expect(x.chain.fund).not.toHaveBeenCalled();});
  it('detects conflicting RoundPaid ledger hashes',async()=>{
    const x=setup(),p=chunks(x.ledger,1)[0];x.paid.set(p.roundId,p);vi.mocked(x.chain.evidence).mockResolvedValue({ledgerHash:H(777),legs:[]});await expect(x.executor.execute(x.ledger)).rejects.toThrow('does not match');expect(x.chain.fund).not.toHaveBeenCalled();
  });
  it('reports per-leg failures and retries only outstanding addresses',async()=>{
    const x=setup();x.failureMap.set(`1000:${alice}`,100n);await x.executor.execute(x.ledger);expect(x.alerts.send).toHaveBeenCalledWith('failed',expect.objectContaining({count:1}));
    await x.executor.retryFailed(1000n,[alice,bob],1);expect(x.chain.retry).toHaveBeenCalledWith(1000n,[alice],'retry:1000:1');
  });
  it('writes off once and releases a proved reserved amount as contract credit',async()=>{
    const x=setup();x.failureMap.set(`1000:${alice}`,100n);await x.executor.execute(x.ledger);await x.executor.writeOffFailed(1000n,alice);await x.executor.writeOffFailed(1000n,alice);
    const account=x.store.read<any>('private/funding-account.json',null);expect(account.credits[`writeOff:1000:${alice}`]).toBe(100n);
  });
});
