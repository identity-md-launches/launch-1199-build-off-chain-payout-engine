import { describe,it,expect } from 'vitest';
import { readPool,rebuild,groupTransactions,transactionInputs } from '../src/indexer.js';
import { IMD,Q96 } from '../src/config.js';
import { config,baseEvents,buyEvents,event,alice,bob,A,H } from './helpers.js';
describe('transaction grouping and v4 swap fixtures',()=>{
  for(const imdIs1 of [true,false])for(const exactInput of [true,false]){
    it(`fee-paid buy (${imdIs1?'token0':'token1'}, ${exactInput?'exact-input':'exact-output'})`,()=>{
      const c=config(),base=baseEvents(c,imdIs1),buys=buyEvents(c,alice,2,imdIs1,exactInput?100n:99n,exactInput?1000n:1010n);
      // Logs are deliberately supplied out of order and split across contract queries.
      const state=rebuild([...buys,...base].reverse(),c);
      expect(state.wallets.get(alice)!.qualifyingTokens).toBe(exactInput?100n:99n);
      expect(state.wallets.get(alice)!.cost).toBe(exactInput?1050n:1060n);
      expect(state.pool.imdIsCurrency1).toBe(imdIs1);
    });
    it(`sell (${imdIs1?'token0':'token1'}, ${exactInput?'exact-input':'exact-output'}) permanently voids`,()=>{
      const c=config(),base=[...baseEvents(c,imdIs1),...buyEvents(c,alice,2,imdIs1)];
      const sold=exactInput?20n:25n;
      const sells=[event(c,'Transfer',{from:alice,to:c.launch.poolManager,value:sold},3,0),
        event(c,'Swap',{id:c.launch.poolId,amount0:imdIs1?-sold:100n,amount1:imdIs1?100n:-sold,sqrtPriceX96:Q96},3,1),
        event(c,'FeeAccrued',{isSell:true,baseFeeImd:5n,surchargeImd:20n,imdLeg:100n},3,2)];
      const w=rebuild([...base,...sells],c).wallets.get(alice)!;expect(w.disqualified).toBe(true);expect(w.cost).toBe(1050n);expect(w.balance).toBe(100n-sold);
    });
  }
  it('groups by transaction, never by block or adjacent log position',()=>{
    const c=config(),buy=buyEvents(c);const tx2=event(c,'Transfer',{from:c.launch.poolManager,to:bob,value:10n},2,3,22);tx2.transactionIndex=1;
    expect(groupTransactions([...buy,tx2]).map(x=>x.length)).toEqual([3,1]);
    const state=rebuild([...baseEvents(c),...buy,tx2],c);expect(state.wallets.get(bob)!.cost).toBe(0n);
  });
  it('ordinary ETH router buy follows MONEYBACK flow and IMD basis',()=>{
    const c=config(),buy=buyEvents(c,c.launch.router);buy.push(event(c,'Transfer',{from:c.launch.router,to:alice,value:100n},2,3));
    const w=rebuild([...baseEvents(c),...buy],c).wallets.get(alice)!;expect(w.qualifyingTokens).toBe(100n);expect(w.cost).toBe(1050n);
  });
  it('other-pool same-tx output cannot increase qualifying quantity or basis',()=>{
    const c=config(),buy=buyEvents(c,alice);buy[2].args.value=200n;
    buy.push(event(c,'Swap',{id:H(900),amount0:100n,amount1:-2000n,sqrtPriceX96:Q96},2,4));
    const w=rebuild([...baseEvents(c),...buy],c).wallets.get(alice)!;expect(w.balance).toBe(200n);expect(w.qualifyingTokens).toBe(100n);expect(w.cost).toBe(1050n);
  });
  it('does not count unrelated/top-up IMD inflows or the sweep transfer twice',()=>{
    const c=config(),s=event(c,'Swept',{imdAmount:100n,to:c.launch.payoutWallet},2,0);
    const transfer=event(c,'Transfer',{from:c.launch.poolManager,to:c.launch.payoutWallet,value:100n},2,1);transfer.address=IMD;
    const dist=event(c,'Transfer',{from:c.launch.distributor,to:c.launch.payoutWallet,value:40n},3,0);dist.address=IMD;
    const topup=event(c,'Transfer',{from:alice,to:c.launch.payoutWallet,value:9999n},4,0);topup.address=IMD;
    const r=rebuild([...baseEvents(c),s,transfer,dist,topup],c).receipts;expect(r.map(x=>[x.kind,x.amount])).toEqual([['sweep',100n],['distributor',40n]]);
    expect(()=>rebuild([...baseEvents(c),s],c)).toThrow('matching IMD');
  });
  it('rebuilds Paid/PayFailed/retry/WrittenOff without charging unsuccessful legs as paid',()=>{
    const c=config(),logs=[...baseEvents(c),...buyEvents(c),event(c,'PayFailed',{roundId:1000n,to:alice,amount:10n},3)];
    expect(rebuild(logs,c).wallets.get(alice)!.reserved).toBe(10n);expect(rebuild(logs,c).wallets.get(alice)!.paid).toBe(0n);
    const recovered=rebuild([...logs,event(c,'Paid',{roundId:1000n,to:alice,amount:10n},4)],c).wallets.get(alice)!;
    expect(recovered.paid).toBe(10n);expect(recovered.reserved).toBe(0n);
    expect(rebuild([...logs,event(c,'WrittenOff',{roundId:1000n,to:alice,amount:10n},4)],c).wallets.get(alice)!.reserved).toBe(0n);
  });
  it('rejects duplicate events, missing Initialize and conflicting initialization facts',()=>{
    const c=config(),base=baseEvents(c);expect(()=>rebuild([...base,base[0]],c)).toThrow('Duplicate');expect(()=>readPool([],c.launch)).toThrow();
    base[1].args.currency0=A(333);expect(()=>readPool(base,c.launch)).toThrow('does not match');
  });
  it('a hook fee without matching pool buys is not silently accepted',()=>{
    const c=config(),base=baseEvents(c),fees=buyEvents(c).filter(e=>e.name!=='Swap');
    expect(()=>rebuild([...base,...fees],c)).toThrow('Ambiguous');
  });
});

import { Indexer,decodeLog,TOKEN_ABI } from '../src/indexer.js';
import { RPC } from '../src/rpc.js';
import { encodeEventTopics } from 'viem';
it('binds persisted state to every launch deployment address',()=>{const c=config(),rpc=new RPC(c),indexer=new Indexer(c,rpc);rpc.store.write('private/indexer.json',indexer.state);c.launch.roundPayout=A(999);expect(()=>new Indexer(c,rpc)).toThrow('another launch');});
it('fails closed on malformed expected logs instead of silently dropping a fee or transfer',()=>{const c=config(),topics=encodeEventTopics({abi:TOKEN_ABI,eventName:'Transfer',args:{from:alice,to:bob}});expect(()=>decodeLog({address:c.launch.token,data:'0x',topics:topics as any,blockNumber:1n,blockHash:H(1),transactionHash:H(1),transactionIndex:0,logIndex:0},c.launch,1000)).toThrow('Malformed');});
