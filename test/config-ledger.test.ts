import { describe,it,expect } from 'vitest';
import { existsSync,readFileSync } from 'node:fs';
import { loadConfig,validateLaunch,address,IMD } from '../src/config.js';
import { Store,canonical } from '../src/ledger.js';
import { config,A } from './helpers.js';
describe('configuration and durable ledgers',()=>{
  it('validates launch metadata and safe defaults without reading a key',()=>{
    const c=config(),loaded=loadConfig({RPC_URLS:'http://localhost:1,http://localhost:2',RPC_PRIORITY_URL:'http://localhost:3'},c.launch);
    expect(loaded.executor).toBe('dry-run');expect(loaded.rpc.pollMs).toBe(750);expect(loaded.rpc.anchorSpacing).toBe(100n);expect(loaded.exec.confirmations).toBe(5);expect(loaded.rules.maxRecipientsPerTx).toBe(200);expect(loaded.ops.skimFraction).toBe(0n);
  });
  it('refuses missing addresses, placeholder addresses, wrong chains and bad economics',()=>{
    const c=config();expect(()=>validateLaunch({...c.launch,payoutWallet:A(0)})).toThrow();expect(()=>validateLaunch({...c.launch,token:'<supply token>'})).toThrow();expect(()=>validateLaunch({...c.launch,chainId:1})).toThrow();
    expect(()=>loadConfig({RPC_URLS:'http://localhost',RPC_PRIORITY_URL:'http://localhost',OPS_SKIM_FRACTION:'1.1'},c.launch)).toThrow();
    expect(()=>loadConfig({RPC_URLS:'http://localhost',RPC_PRIORITY_URL:'http://localhost',MAX_RECIPIENTS_PER_TX:'0'},c.launch)).toThrow();
  });
  it('validates ABI members and currency distinction',()=>{const c=config();expect(()=>validateLaunch({...c.launch,abis:{...c.launch.abis,hook:[]}})).toThrow();expect(()=>validateLaunch({...c.launch,token:IMD})).toThrow();});
  it('atomically round trips bigint state and enforces immutable canonical ledger bytes',()=>{
    const c=config(),store=new Store(c.dataDir);store.write('private/test.json',{a:2n,nested:[3n]});expect(store.read('private/test.json',{})).toEqual({a:2n,nested:[3n]});
    store.immutable('ledgers/1.json',{z:2n,a:1});expect(readFileSync(store.path('ledgers/1.json'),'utf8')).toBe('{"a":1,"z":"2"}');store.immutable('ledgers/1.json',{a:1,z:2n});expect(()=>store.immutable('ledgers/1.json',{a:2})).toThrow();expect(()=>store.path('../secret')).toThrow();
  });
});
