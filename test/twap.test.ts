import { describe,it,expect } from 'vitest';
import { Q96 } from '../src/config.js';
import { twap,priceX96,epochIndex,epochClose,type Observation } from '../src/twap.js';
const o=(t:number,p:bigint,i=0):Observation=>({timestamp:t,priceX96:p*Q96,blockNumber:BigInt(t+1),logIndex:i});
describe('TWAP',()=>{
  it('integrates only the final three minutes, using the price at window start',()=>{
    expect(twap([o(0,99n),o(100,10n),o(240,20n),o(300,999n)],300)).toBe((10n*120n+20n*60n)*Q96/180n);
  });
  it('carries the last price through an empty window',()=>expect(twap([o(1,17n)],1000)).toBe(17n*Q96));
  it('same timestamp last chain log wins, including the start boundary',()=>{
    expect(twap([o(0,1n),o(120,5n,2),o(120,3n,1),o(180,11n)],300)).toBe(9n*Q96);
  });
  it('ignores events at close and in the future',()=>expect(twap([o(0,1n),o(900,100n)],900)).toBe(Q96));
  it('refuses missing initial history and invalid prices/windows',()=>{
    expect(()=>twap([o(200,1n)],300)).toThrow();expect(()=>twap([o(0,0n)],300)).toThrow();expect(()=>twap([],300,0)).toThrow();
  });
  it('normalizes either currency ordering without floats',()=>{
    expect(priceX96(2n*Q96,true)).toBe(4n*Q96);expect(priceX96(2n*Q96,false)).toBe(Q96/4n);expect(()=>priceX96(0n,true)).toThrow();
  });
  it('uses launch-relative fixed epoch grid',()=>{
    expect(epochIndex(1000,1899)).toBe(0);expect(epochIndex(1000,1900)).toBe(1);expect(epochClose(1000,2)).toBe(2800);expect(()=>epochClose(1000,0)).toThrow();
  });
});
