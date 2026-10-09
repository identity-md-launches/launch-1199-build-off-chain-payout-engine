import { it,expect,vi } from 'vitest';
import { abandonPrepared } from '../scripts/abandon-round.js';
import { initialEngine } from '../src/rounds.js';
import { makeLedger } from '../src/payout.js';
import { eligibility } from '../src/eligibility.js';
import { emptyTreasury } from '../src/fees.js';
import { Store } from '../src/ledger.js';
import { Q96 } from '../src/config.js';
import { config,wallet,H } from './helpers.js';
function setup(){const c=config();c.executor='live';const store=new Store(c.dataDir),engine=initialEngine(c),ledger=makeLedger(1,1900,Q96,[eligibility(wallet(),Q96,0n)],100n,0n);engine.intent={startedAt:Date.now(),ledger,booked:{...emptyTreasury(),pot:100n},claimThroughBlock:90n};store.write('private/engine.json',engine);return {c,store,chain:{isPaid:vi.fn(async()=>false)} as any};}
it('abandons an entirely unsent round without broadcasting and rolls the full pot',async()=>{const x=setup();const result=await abandonPrepared(x.c,x.store,x.chain,async()=>{throw new Error('no transactions expected');},100n);expect(result.released).toBe(100n);const engine=x.store.read<any>('private/engine.json',null);expect(engine.treasury.pot).toBe(100n);expect(engine.intent).toBe(null);expect(engine.rounds[0].status).toBe('abandoned');});
it('refuses to release funds while a signed intent has unknown outcome',async()=>{const x=setup();x.store.write('private/transactions.json',{'epoch:1:pay:0':{hash:H(1)}});await expect(abandonPrepared(x.c,x.store,x.chain,async()=>{throw new Error('pending');},100n)).rejects.toThrow('pending');expect(x.store.read<any>('private/engine.json',null).intent).not.toBe(null);});
