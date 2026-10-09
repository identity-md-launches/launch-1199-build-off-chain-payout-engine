import { describe,it,expect } from 'vitest';
import { applyTransaction,eligibility,emptyWallet,type WalletTx } from '../src/eligibility.js';
import { Q96,exclusions } from '../src/config.js';
import { A,alice,bob,config,wallet } from './helpers.js';
const setup=()=>{
  const c=config(),pool=c.launch.poolManager;
  const previous=new Map([[pool,{...emptyWallet(pool),balance:10000n}],[bob,{...emptyWallet(bob),balance:200n}]]);
  const tx:WalletTx={transfers:[{from:pool,to:alice,amount:100n,logIndex:1}],buys:[{tokens:100n,cost:1050n,feePaid:50n}],poolManager:pool,excluded:exclusions(c),contracts:new Set()};
  return {c,pool,previous,tx};
};
describe('coverage rules',()=>{
  it('counts only fee-paid pool output and its all-fee basis',()=>{const {previous,tx}=setup();const w=applyTransaction(previous,tx).get(alice)!;expect(w.qualifyingTokens).toBe(100n);expect(w.cost).toBe(1050n);expect(eligibility(w,Q96,1000n).eligible).toBe(true);});
  it('fee-free buys do not qualify',()=>{const {previous,tx}=setup();tx.buys[0].feePaid=0n;const w=applyTransaction(previous,tx).get(alice)!;expect(w.balance).toBe(100n);expect(w.cost).toBe(0n);});
  it('OTC, other pools and airdrops have no basis and do not void existing cover',()=>{
    const {previous,tx,pool}=setup();let state=applyTransaction(previous,tx);
    state=applyTransaction(state,{...tx,buys:[],transfers:[{from:bob,to:alice,amount:20n,logIndex:0},{from:A(0),to:alice,amount:10n,logIndex:1},{from:pool,to:alice,amount:30n,logIndex:2}]});
    const w=state.get(alice)!;expect(w.balance).toBe(160n);expect(w.qualifyingTokens).toBe(100n);expect(w.cost).toBe(1050n);expect(w.disqualified).toBe(false);
  });
  it('does not give OTC tokens basis when they arrive in the same pool-buy tx',()=>{const {previous,tx}=setup();tx.transfers.push({from:bob,to:alice,amount:50n,logIndex:2});const w=applyTransaction(previous,tx).get(alice)!;expect(w.balance).toBe(150n);expect(w.qualifyingTokens).toBe(100n);expect(w.cost).toBe(1050n);});
  it('routes output through a contract, excluding the router itself',()=>{
    const {previous,tx,c,pool}=setup();tx.transfers=[{from:pool,to:c.launch.router,amount:100n,logIndex:2},{from:c.launch.router,to:alice,amount:100n,logIndex:3}];
    const state=applyTransaction(previous,tx);expect(state.get(alice)!.cost).toBe(1050n);expect(state.get(c.launch.router)!.disqualified).toBe(true);
  });
  it('any outflow permanently voids even if net balance rises or is replenished',()=>{
    const {previous,tx}=setup();previous.set(alice,wallet());tx.transfers.unshift({from:alice,to:bob,amount:1n,logIndex:0});
    let state=applyTransaction(previous,tx);expect(state.get(alice)!.balance).toBe(199n);expect(state.get(alice)!.disqualified).toBe(true);
    state=applyTransaction(state,tx);expect(eligibility(state.get(alice)!,Q96,0n).eligible).toBe(false);
  });
  it('a self transfer or zero transfer does not decrease balance',()=>{const {previous,tx}=setup();previous.set(alice,wallet());tx.buys=[];tx.transfers=[{from:alice,to:alice,amount:90n,logIndex:1},{from:alice,to:bob,amount:0n,logIndex:2}];expect(applyTransaction(previous,tx).get(alice)!.disqualified).toBe(false);});
  it('buying more retains cover and computes VWAP',()=>{const {previous,tx}=setup();previous.set(alice,wallet());const w=applyTransaction(previous,tx).get(alice)!;expect(w.qualifyingTokens).toBe(200n);expect(w.cost).toBe(2050n);expect(eligibility(w,Q96,2051n).reason).toBe('below-min-buy');expect(eligibility(w,Q96,2050n).entry).toBe(2050n*Q96/200n);});
  it('excludes all system/configured/code addresses',()=>{const {previous,tx,c}=setup();tx.contracts.add(alice);expect(applyTransaction(previous,tx).get(alice)!.reason).toBe('contract');c.rules.excluded=[bob];expect(exclusions(c).has(bob)).toBe(true);expect(exclusions(c).has(c.launch.deployer)).toBe(true);});
  it('requires still holding ALL qualifying tokens, and never pays on gains',()=>{
    expect(eligibility({...wallet(),balance:99n},Q96,0n).eligible).toBe(false);
    expect(eligibility(wallet(),20n*Q96,0n).loss).toBe(0n);
    expect(eligibility(emptyWallet(alice),Q96,0n).reason).toBe('no-qualifying-buy');
  });
  it('reserves failed legs against made-whole cap',()=>{const w={...wallet(),paid:800n,reserved:95n};const e=eligibility(w,Q96,0n);expect(e.loss).toBe(900n);expect(e.cap).toBe(5n);});
  it('rejects incomplete histories rather than manufacturing balances',()=>{const {previous,tx}=setup();tx.transfers[0].amount=10001n;expect(()=>applyTransaction(previous,tx)).toThrow('Incomplete');});
  it('does not mutate the input ledger',()=>{const {previous,tx,pool}=setup();applyTransaction(previous,tx);expect(previous.get(pool)!.balance).toBe(10000n);expect(previous.has(alice)).toBe(false);});
});
