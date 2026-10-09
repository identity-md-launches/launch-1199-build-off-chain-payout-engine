import { encodeFunctionData, type Address, type Hex } from 'viem';
import { IMD, WAD, type Config, type Launch } from './config.js';
export type ClaimReceipt = { id:string; kind:'sweep'|'distributor'; amount:bigint; blockNumber:bigint; timestamp:number; transactionHash:Hex };
export type Treasury = { pot:bigint; team:bigint; ops:bigint; dexReserved:bigint; reserveRemaining:bigint; booked:string[] };
export const emptyTreasury=(reserve=0n):Treasury=>{if(reserve<0n)throw new Error('Negative reserve');return {pot:0n,team:0n,ops:0n,dexReserved:0n,reserveRemaining:reserve,booked:[]};};
export function bookClaim(prior:Treasury,receipts:readonly ClaimReceipt[],skimFraction=0n):Treasury {
  if(skimFraction<0n||skimFraction>WAD) throw new Error('Invalid skim');
  const out={...prior,booked:[...prior.booked]}, seen=new Set(prior.booked);
  for(const r of [...receipts].sort((a,b)=>a.blockNumber<b.blockNumber?-1:a.blockNumber>b.blockNumber?1:a.id.localeCompare(b.id))) {
    if(seen.has(r.id)) continue;
    if(r.amount<0n) throw new Error('Negative receipt');
    seen.add(r.id);out.booked.push(r.id);
    const pouch=r.kind==='sweep'?r.amount:r.amount/4n;
    out.team+=r.kind==='distributor'?r.amount-pouch:0n;
    const skim=pouch*skimFraction/WAD;out.ops+=skim;
    const available=pouch-skim;
    const reserve=available<out.reserveRemaining?available:out.reserveRemaining;
    out.dexReserved+=reserve;out.reserveRemaining-=reserve;out.pot+=available-reserve;
  }
  return out;
}
export type WriteOffReceipt={id:string;roundId:bigint;to:Address;amount:bigint;blockNumber:bigint};
/** A write-off returns an earlier reserved payout, not new fee income: no second skim or reserve. */
export function bookRefunds(prior:Treasury,refunds:readonly WriteOffReceipt[],knownRoundIds:ReadonlySet<string>):Treasury {
  const out={...prior,booked:[...prior.booked]},seen=new Set(prior.booked);
  for(const refund of refunds){if(!knownRoundIds.has(refund.roundId.toString())||seen.has(refund.id))continue;
    if(refund.amount<0n)throw new Error('Negative write-off');seen.add(refund.id);out.booked.push(refund.id);out.pot+=refund.amount;}
  return out;
}
export type ContractCall={ to:Address; data:Hex; value?:bigint };
export function sweepCall(launch:Launch):ContractCall {
  return {to:launch.hook,data:encodeFunctionData({abi:launch.abis.hook,functionName:'sweep',args:[]})};
}
export function distributorCall(launch:Launch):ContractCall {
  return {to:launch.distributor,data:encodeFunctionData({abi:launch.abis.distributor,...launch.distributorClaim} as any)};
}
export async function pending(client:any,launch:Launch):Promise<{hook:bigint;distributor:bigint}> {
  const hook=await client.readContract({address:launch.hook,abi:launch.abis.hook,functionName:'pending',args:[]});
  const distributor=await client.readContract({address:launch.distributor,abi:launch.abis.distributor,...launch.distributorPending});
  if(typeof hook!=='bigint'||typeof distributor!=='bigint'||hook<0n||distributor<0n) throw new Error('pending() must return uint256');
  return {hook,distributor};
}
export async function collectFees(c:Config,client:any,send:(id:string,call:ContractCall)=>Promise<unknown>,epoch:number):Promise<void> {
  const p=await pending(client,c.launch);
  if(c.executor==='dry-run') return;
  if(p.hook>0n) await send(`epoch:${epoch}:sweep`,sweepCall(c.launch));
  if(p.distributor>0n) await send(`epoch:${epoch}:claim`,distributorCall(c.launch));
}
