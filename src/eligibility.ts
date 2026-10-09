import { Q96 } from './config.js';
import type { Address } from 'viem';
export type WalletLedger = { address: Address; balance: bigint; qualifyingTokens: bigint; cost: bigint;
  paid: bigint; reserved: bigint; disqualified: boolean; reason: string | null };
export type Transfer = { from: Address; to: Address; amount: bigint; logIndex: number };
export type Buy = { tokens: bigint; cost: bigint; feePaid: bigint };
export type WalletTx = { transfers: Transfer[]; buys: Buy[]; poolManager: Address; excluded: Set<string>; contracts: Set<string> };
export const emptyWallet = (address: Address): WalletLedger => ({address:address.toLowerCase() as Address,balance:0n,qualifyingTokens:0n,cost:0n,paid:0n,reserved:0n,disqualified:false,reason:null});
const min = (a: bigint,b: bigint)=>a<b?a:b;
/** Propagate OUR pool's output provenance through settlement/router transfers, never through unrelated inflows. */
export function applyTransaction(previous: ReadonlyMap<string,WalletLedger>, tx: WalletTx): Map<string,WalletLedger> {
  return applyTransactions(previous,[tx]);
}
export function applyTransactions(previous: ReadonlyMap<string,WalletLedger>, transactions: readonly WalletTx[]): Map<string,WalletLedger> {
  const state = new Map([...previous].map(([a,w])=>[a,{...w}]));
  for(const tx of transactions)applyInto(state,tx);
  return state;
}
function applyInto(state: Map<string,WalletLedger>, tx: WalletTx): Map<string,WalletLedger> {
  const manager = tx.poolManager.toLowerCase();
  const transfers = [...tx.transfers].sort((a,b)=>a.logIndex-b.logIndex);
  const buys = tx.buys.filter(b=>b.tokens>0n && b.cost>0n && b.feePaid>0n);
  const output = buys.reduce((n,b)=>n+b.tokens,0n), cost = buys.reduce((n,b)=>n+b.cost,0n);
  const managerOut = transfers.filter(t=>t.from.toLowerCase()===manager && t.to.toLowerCase()!==manager).reduce((n,t)=>n+t.amount,0n);
  const provenance = new Map<string,bigint>();
  const intra = new Map<string,bigint>();
  const before = new Map<string,bigint>();
  const get = (a: string) => {
    if (!state.has(a)) state.set(a,emptyWallet(a as Address));
    if (!before.has(a)) before.set(a,state.get(a)!.balance);
    const w = state.get(a)!;
    if (tx.excluded.has(a) || tx.contracts.has(a)) { w.disqualified=true; w.reason ||= tx.contracts.has(a)?'contract':'excluded'; }
    return w;
  };
  for (const t of transfers) {
    if (t.amount < 0n) throw new Error('Negative transfer');
    const from=t.from.toLowerCase(), to=t.to.toLowerCase(), sender=get(from), receiver=get(to);
    if (from===to || t.amount===0n) continue;
    // Mints have no debit. Zero is a protocol sentinel, never a configured recipient.
    if (!/^0x0{40}$/.test(from)) {
      sender.balance -= t.amount;
      if (sender.balance < 0n) throw new Error('Incomplete token history: negative balance');
      sender.disqualified=true; sender.reason ||= 'balance-decrease';
    }
    receiver.balance += t.amount;
    let taint = 0n;
    if (from === manager && managerOut>0n) taint=t.amount*min(output,managerOut)/managerOut;
    else {
      const held = intra.get(from) || 0n, eligible = provenance.get(from) || 0n;
      // Existing and unrelated tokens dilute provenance; they can never acquire basis by moving through a router.
      const preBalance = sender.balance+t.amount;
      const denom = preBalance > held ? preBalance : held;
      taint = denom>0n ? min(eligible,t.amount*eligible/denom) : 0n;
      provenance.set(from,eligible-taint);
    }
    provenance.set(to,(provenance.get(to)||0n)+taint);
    intra.set(from,(intra.get(from)||0n)-t.amount); intra.set(to,(intra.get(to)||0n)+t.amount);
  }
  for (const [a,tokens] of provenance) {
    const w=get(a);
    if (tokens>0n && output>0n && w.balance>(before.get(a)||0n)) {
      const delivered=min(tokens,w.balance-(before.get(a)||0n));
      w.qualifyingTokens += delivered; w.cost += cost*delivered/output;
    }
  }
  return state;
}
export type Eligibility = { address: Address; eligible: boolean; reason: string | null; heldQualifyingTokens: bigint;
  cost: bigint; entry: bigint; close: bigint; loss: bigint; paid: bigint; reserved: bigint; remaining: bigint; cap: bigint };
export function eligibility(w: WalletLedger, close: bigint, minBuy: bigint): Eligibility {
  if (close<0n || minBuy<0n || w.balance<0n || w.qualifyingTokens<0n || w.cost<0n || w.paid<0n || w.reserved<0n) throw new Error('Negative accounting value');
  const entry=w.qualifyingTokens>0n?w.cost*Q96/w.qualifyingTokens:0n;
  const reason=w.disqualified?w.reason||'disqualified':w.qualifyingTokens===0n?'no-qualifying-buy':w.balance<w.qualifyingTokens?'missing-qualifying-tokens':w.cost<minBuy?'below-min-buy':null;
  const delta=entry>close?entry-close:0n;
  const loss=delta*w.qualifyingTokens/Q96;
  const used=w.paid+w.reserved, remaining=loss>used?loss-used:0n;
  const cap=min(loss/3n,remaining);
  return {address:w.address,eligible:reason===null,reason,heldQualifyingTokens:w.qualifyingTokens,cost:w.cost,entry,close,loss,paid:w.paid,reserved:w.reserved,remaining,cap:reason===null?cap:0n};
}
