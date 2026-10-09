import { describe,it,expect,vi } from 'vitest';
import { bookClaim,emptyTreasury,sweepCall,distributorCall,pending,type ClaimReceipt } from '../src/fees.js';
import { WAD } from '../src/config.js';
import { decodeFunctionData } from 'viem';
import { config,H } from './helpers.js';
const r=(id:string,kind:'sweep'|'distributor',amount:bigint):ClaimReceipt=>({id,kind,amount,blockNumber:1n,timestamp:1000,transactionHash:H(1)});
describe('bookClaim',()=>{
  it('books all sweeps and exactly the distributor pouch share',()=>{const t=bookClaim(emptyTreasury(),[r('a','sweep',425n),r('b','distributor',100n)]);expect(t.pot).toBe(450n);expect(t.team).toBe(75n);});
  it('deduplicates claims, preserves leftover and never skims it twice',()=>{let t=bookClaim(emptyTreasury(),[r('a','sweep',100n)],WAD/10n);expect(t.pot).toBe(90n);t=bookClaim(t,[r('a','sweep',100n)],WAD/10n);expect(t.pot).toBe(90n);expect(t.ops).toBe(10n);});
  it('takes ops skim then one-time reserve, carrying an unfilled reserve',()=>{let t=bookClaim(emptyTreasury(100n),[r('a','sweep',60n)],WAD/10n);expect(t.pot).toBe(0n);expect(t.reserveRemaining).toBe(46n);t=bookClaim(t,[r('b','sweep',100n)],WAD/10n);expect(t.pot).toBe(44n);expect(t.dexReserved).toBe(100n);expect(t.ops).toBe(16n);expect(t.reserveRemaining).toBe(0n);});
  it('assigns distributor integer dust to team',()=>{const t=bookClaim(emptyTreasury(),[r('a','distributor',7n)]);expect(t.pot).toBe(1n);expect(t.team).toBe(6n);});
  it('rejects invalid skim and negative receipt',()=>{expect(()=>bookClaim(emptyTreasury(),[],WAD+1n)).toThrow();expect(()=>bookClaim(emptyTreasury(),[r('a','sweep',-1n)])).toThrow();});
  it('encodes only the configured sweep and distributor calls',()=>{const c=config();expect(sweepCall(c.launch).to).toBe(c.launch.hook);expect(decodeFunctionData({abi:c.launch.abis.hook,data:sweepCall(c.launch).data}).functionName).toBe('sweep');expect(distributorCall(c.launch).to).toBe(c.launch.distributor);});
  it('reads pending amounts and rejects an incompatible ABI return',async()=>{const c=config(),client={readContract:vi.fn().mockResolvedValueOnce(3n).mockResolvedValueOnce(4n)};expect(await pending(client,c.launch)).toEqual({hook:3n,distributor:4n});client.readContract.mockResolvedValue([1n,2n]);await expect(pending(client,c.launch)).rejects.toThrow();});
});

import { bookRefunds } from '../src/fees.js';
it('returns only recognized written-off reservations without skimming them twice',()=>{
  const refund={id:'writeoff-event',roundId:1000n,to:config().launch.payoutWallet,amount:17n,blockNumber:100n};
  expect(bookRefunds(emptyTreasury(),[refund],new Set()).pot).toBe(0n);
  const once=bookRefunds(emptyTreasury(),[refund],new Set(['1000']));expect(once.pot).toBe(17n);expect(once.ops).toBe(0n);
  expect(bookRefunds(once,[refund],new Set(['1000'])).pot).toBe(17n);
});
