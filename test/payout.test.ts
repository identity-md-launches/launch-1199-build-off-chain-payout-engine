import { describe,it,expect } from 'vitest';
import { allocate,makeLedger,chunks } from '../src/payout.js';
import { eligibility } from '../src/eligibility.js';
import { Q96 } from '../src/config.js';
import { canonical,ledgerHash } from '../src/ledger.js';
import { keccak256,toBytes } from 'viem';
import { alice,bob,A,wallet } from './helpers.js';
const e=(a=alice,cost=1000n,paid=0n)=>eligibility({...wallet(a,100n,cost),paid},Q96,0n);
describe('payout allocation',()=>{
  it('caps each drop at one third of CURRENT loss',()=>{const r=allocate([e()],9999n,0n);expect(r.payees[0].amount).toBe(300n);expect(r.leftover).toBe(9699n);});
  it('made-whole cap applies cumulatively and allows a new loss',()=>{
    expect(allocate([e(alice,1000n,890n)],100n,0n).payees[0].amount).toBe(10n);
    expect(allocate([e(alice,1000n,900n)],100n,0n).payees).toEqual([]);
    expect(allocate([e(alice,1100n,900n)],100n,0n).payees[0].amount).toBe(100n);
  });
  it('splits by pure loss share and rolls capped excess',()=>{
    const r=allocate([e(alice,1000n),e(bob,400n)],120n,0n);expect(r.payees.map(x=>x.amount)).toEqual([90n,30n]);
    const capped=allocate([e(alice,1000n,890n),e(bob,400n)],100n,0n);expect(capped.payees.map(x=>x.amount)).toEqual([10n,25n]);expect(capped.leftover).toBe(65n);
  });
  it('rolls rounding dust and all skipped minimum legs',()=>{const r=allocate([e(),e(bob)],7n,4n);expect(r.payees).toEqual([]);expect(r.leftover).toBe(7n);const next=allocate([e(),e(bob)],r.leftover+3n,4n);expect(next.payees.map(x=>x.amount)).toEqual([5n,5n]);});
  it('excludes zero/negative loss and ineligible wallets',()=>expect(allocate([{...e(),eligible:false},e(bob,10n)],10n,0n).leftover).toBe(10n));
  it('conserves arbitrary budgets and respects both caps',()=>{
    for(let pot=0n;pot<1500n;pot+=17n){const ws=[e(),e(bob,400n,250n),e(A(120),500n)];const r=allocate(ws,pot,3n);expect(r.leftover+r.payees.reduce((n,p)=>n+p.amount,0n)).toBe(pot);for(const p of r.payees){const w=ws.find(w=>w.address===p.payee)!;expect(p.amount<=w.loss/3n&&p.amount<=w.remaining).toBe(true);}}
  });
  it('chunks at 200 and keeps round IDs and common hash stable',()=>{
    const ws=Array.from({length:401},(_,i)=>e(A(i+100)));const l=makeLedger(12,11800,Q96,ws,100000n,0n),cs=chunks(l);
    expect(cs.map(c=>c.payees.length)).toEqual([200,200,1]);expect(cs.map(c=>c.roundId)).toEqual([12000n,12001n,12002n]);expect(new Set(cs.map(c=>c.ledgerHash)).size).toBe(1);
    expect(()=>chunks(l,0)).toThrow();expect(()=>chunks({...l,payees:Array(1001).fill(l.payees[0])},1)).toThrow();
  });
  it('canonicalizes key order, bigint decimals and input wallet ordering',()=>{
    const a=makeLedger(1,1900,Q96,[e(),e(bob)],100n,0n),b=makeLedger(1,1900,Q96,[e(bob),e()],100n,0n);
    expect(canonical(a)).toBe(canonical(b));expect(ledgerHash(a)).toBe(keccak256(toBytes(canonical(a))));expect(canonical({z:2n,a:1})).toBe('{"a":1,"z":"2"}');
    expect(ledgerHash({...a,pot:101n})).not.toBe(ledgerHash(a));expect(()=>canonical({bad:undefined})).toThrow();
  });
  it('rejects duplicate recipients and invalid accounting input',()=>{expect(()=>allocate([e(),e()],1n,0n)).toThrow();expect(()=>allocate([], -1n,0n)).toThrow();});
});
