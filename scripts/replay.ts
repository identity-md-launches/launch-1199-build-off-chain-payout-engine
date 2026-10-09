import { readFileSync,existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig,type Config } from '../src/config.js';
import { canonical,ledgerHash,Store } from '../src/ledger.js';
import { decodeLog,type Event,type IndexState } from '../src/indexer.js';
import { replayEvents,type EngineState } from '../src/rounds.js';
import { RPC } from '../src/rpc.js';
import { chunks,type DropLedger } from '../src/payout.js';
import { epochIndex } from '../src/twap.js';
import { decodeEventLog } from 'viem';
export function fixtureInput(file:string):{config:Config;events:Event[];throughEpoch:number;contracts:Set<string>}{
  const fixture=JSON.parse(readFileSync(file,'utf8'));
  const config=loadConfig({RPC_URLS:'http://fixture.invalid',RPC_PRIORITY_URL:'http://fixture.invalid',EXECUTOR:'dry-run',...fixture.settings},fixture.launch);
  const events=fixture.logs.map((l:any)=>decodeLog({...l,blockNumber:BigInt(l.blockNumber)},config.launch,l.timestamp)).filter(Boolean) as Event[];
  return {config,events,throughEpoch:fixture.throughEpoch,contracts:new Set(fixture.contracts||[])};
}
export function compareLedgers(ledgers:DropLedger[],directory:string):string[]{
  const diffs:string[]=[];
  for(const ledger of ledgers){const file=resolve(directory,`${ledger.epochIndex}.json`);if(!existsSync(file)||readFileSync(file,'utf8')!==canonical(ledger))diffs.push(`epoch ${ledger.epochIndex}: ledger bytes differ`);}
  return diffs;
}
function flags(){const args:Record<string,string>={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw new Error('Expected --name value');args[process.argv[i].slice(2)]=process.argv[i+1];}return args;}
export async function main(){
  const args=flags();let c:Config,events:Event[],last:number,contracts:Set<string>,cutoffs:Record<number,bigint>={};
  let actualDebits:Record<number,bigint>={},abandoned:Record<number,string[]>={};
  let observed:any[]=[],contractBlocks:Record<string,bigint>={};
  if(args.fixture){const f=fixtureInput(args.fixture);c=f.config;events=f.events;last=f.throughEpoch;contracts=f.contracts;}
  else{
    c=loadConfig();const store=new Store(c.dataDir),index=store.read<IndexState|null>('private/indexer.json',null);
    if(!index)throw new Error('Backfill first, or use --fixture');events=index.events;contracts=new Set(index.contracts);contractBlocks=index.contractBlocks||{};
    const engine=store.read<EngineState|null>('private/engine.json',null);
    for(const round of engine?.rounds||[]){cutoffs[round.epochIndex]=round.claimThroughBlock;if(round.mode==='live')actualDebits[round.epochIndex]=round.amount;if(round.status==='abandoned')abandoned[round.epochIndex]=round.roundIds||[];}
    last=Number(args.through||engine?.completedEpoch||epochIndex(c.launch.launchTs,events.reduce((t,e)=>Math.max(t,e.timestamp),c.launch.launchTs)));
    const rpc=new RPC(c);await rpc.validate();const head=await rpc.safeHead();
    const event=c.launch.abis.roundPayout.find((a:any)=>a.type==='event'&&a.name==='RoundPaid');
    const logs=await rpc.logs({address:c.launch.roundPayout,event},c.launch.launchBlock,head,rpc.priority);
    observed=logs.map(l=>decodeEventLog({abi:c.launch.abis.roundPayout,data:l.data,topics:l.topics as any}));
  }
  const ledgers=replayEvents(events,c,last,cutoffs,contracts,contractBlocks,actualDebits),diffs=args.expected?compareLedgers(ledgers,args.expected):[];
  const expectedRounds=new Map(ledgers.flatMap(l=>chunks(l,c.rules.maxRecipientsPerTx).map(part=>[part.roundId.toString(),part])));
  for(const [epoch,ids] of Object.entries(abandoned))for(const [id,part] of expectedRounds)if(part.roundId/1000n===BigInt(epoch)&&!ids.includes(id))expectedRounds.delete(id);
  for(const event of observed){const args=event.args,part=expectedRounds.get(String(args.roundId));if(!part||part.ledgerHash!==args.ledgerHash||part.twapCloseX96!==BigInt(args.twapCloseX96)||part.totalEligibleLoss!==BigInt(args.totalEligibleLoss))diffs.push(`round ${args.roundId}: on-chain RoundPaid differs`);}
  if(!args.fixture){const found=new Set(observed.map(e=>String(e.args.roundId)));for(const id of expectedRounds.keys())if(!found.has(id))diffs.push(`round ${id}: missing on-chain RoundPaid`);}
  if(args.out){mkdirSync(args.out,{recursive:true});for(const l of ledgers)writeFileSync(resolve(args.out,`${l.epochIndex}.json`),canonical(l));}
  console.log(canonical({epochs:ledgers.length,ledgers:ledgers.map(l=>({epoch:l.epochIndex,hash:ledgerHash(l),amount:l.pot-l.leftover})),diffs}));
  if(diffs.length)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Replay failed: check fixture, launch, cached logs and ABI fields');process.exitCode=1;});
