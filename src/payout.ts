import type { Address, Hex } from 'viem';
import type { Eligibility } from './eligibility.js';
import { ledgerHash } from './ledger.js';
export type Payee = { payee: Address; loss: bigint; entry: bigint; close: bigint; amount: bigint };
export type DropLedger = { version: 1; epochIndex: number; closeTs: number; closeX96: bigint; totalEligibleLoss: bigint; pot: bigint; payees: Payee[]; leftover: bigint };
export type Chunk = { roundId: bigint; chunkIndex: number; payees: Payee[]; ledgerHash: Hex; twapCloseX96: bigint; totalEligibleLoss: bigint };
/** Split once by current loss, then cap each share. Capped excess, integer dust and sub-minimum legs roll forward. */
export function allocate(wallets: readonly Eligibility[], pot: bigint, minPayout: bigint): {payees:Payee[];leftover:bigint} {
  if (pot<0n || minPayout<0n) throw new Error('Negative pot/minimum');
  const sorted=wallets.filter(w=>w.eligible&&w.loss>0n&&w.cap>0n).sort((a,b)=>a.address.localeCompare(b.address));
  if (new Set(sorted.map(x=>x.address.toLowerCase())).size!==sorted.length) throw new Error('Duplicate payee');
  const weight=sorted.reduce((s,w)=>s+w.loss,0n);
  const payees=sorted.flatMap(w=>{
    const share=pot*w.loss/weight,amount=share<w.cap?share:w.cap;
    return amount>0n&&amount>=minPayout?[{payee:w.address,loss:w.loss,entry:w.entry,close:w.close,amount}]:[];
  });
  return {payees,leftover:pot-payees.reduce((s,w)=>s+w.amount,0n)};
}
export function makeLedger(epochIndex:number,closeTs:number,closeX96:bigint,wallets:readonly Eligibility[],pot:bigint,minPayout:bigint):DropLedger {
  if(!Number.isSafeInteger(epochIndex)||epochIndex<1||!Number.isSafeInteger(closeTs)||closeX96<=0n) throw new Error('Invalid epoch');
  return {version:1,epochIndex,closeTs,closeX96,totalEligibleLoss:wallets.filter(w=>w.eligible).reduce((s,w)=>s+w.loss,0n),pot,...allocate(wallets,pot,minPayout)};
}
export function chunks(ledger:DropLedger,maxRecipients=200):Chunk[] {
  if(!Number.isSafeInteger(maxRecipients)||maxRecipients<1) throw new Error('Invalid chunk size');
  const count=Math.ceil(ledger.payees.length/maxRecipients);
  if(count>1000) throw new Error('Round ID chunk space exhausted');
  const hash=ledgerHash(ledger);
  return Array.from({length:count},(_,i)=>({roundId:BigInt(ledger.epochIndex)*1000n+BigInt(i),chunkIndex:i,payees:ledger.payees.slice(i*maxRecipients,(i+1)*maxRecipients),ledgerHash:hash,twapCloseX96:ledger.closeX96,totalEligibleLoss:ledger.totalEligibleLoss}));
}
