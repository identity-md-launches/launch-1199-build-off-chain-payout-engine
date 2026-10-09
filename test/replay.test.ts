import { describe,it,expect } from 'vitest';
import { fixtureInput,compareLedgers } from '../scripts/replay.js';
import { replayEvents } from '../src/rounds.js';
import { canonical } from '../src/ledger.js';
import { readFileSync } from 'node:fs';
describe('fixture replay',()=>{
  it('reproduces all three independently specified ledgers byte-for-byte without RPC',()=>{
    const {config,events,throughEpoch,contracts}=fixtureInput('test/fixtures/replay.json');
    const ledgers=replayEvents(events,config,throughEpoch,{},contracts);
    expect(compareLedgers(ledgers,'test/fixtures/ledgers')).toEqual([]);
    for(const l of ledgers)expect(canonical(l)).toBe(readFileSync(`test/fixtures/ledgers/${l.epochIndex}.json`,'utf8'));
  });
  it('is independent of log input order and detects a changed ledger',()=>{
    const f=fixtureInput('test/fixtures/replay.json');const l=replayEvents([...f.events].reverse(),f.config,3);
    expect(compareLedgers(l,'test/fixtures/ledgers')).toEqual([]);l[0].payees[0].amount++;expect(compareLedgers(l,'test/fixtures/ledgers')).toHaveLength(1);
  });
});
