import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAbi, type Address, type Hex } from 'viem';
import { IMD, RULES, Q96, type Config } from '../src/config.js';
import type { Event } from '../src/indexer.js';
import { emptyWallet } from '../src/eligibility.js';
export const A=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
export const H=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
export const alice=A(100),bob=A(101),carol=A(102),otherPool=A(103);
export const hookAbi=parseAbi(['function sweep()','function pending() view returns (uint256)','event FeeAccrued(bool isSell,uint256 baseFeeImd,uint256 surchargeImd,uint256 imdLeg)','event Swept(uint256 imdAmount,address to)']);
export const roundAbi=parseAbi(['function owner() view returns(address)','function fund(address token,uint256 amount)','function payRound(uint256 roundId,address token,address[] to,uint256[] amounts,bytes32 ledgerHash,uint256 twapCloseX96,uint256 totalEligibleLoss)','function retryFailed(uint256 roundId,address[] to)','function writeOffFailed(uint256 roundId,address to)','function isPaid(uint256 roundId) view returns(bool)','function rounds(uint256 roundId) view returns(bytes32 ledgerHash)','function failed(uint256 roundId,address to) view returns(uint256)','function paused() view returns(bool)',
  'event Funded(address token,uint256 amount)','event Paid(uint256 indexed roundId,address indexed to,uint256 amount)','event PayFailed(uint256 indexed roundId,address indexed to,uint256 amount)','event WrittenOff(uint256 indexed roundId,address indexed to,uint256 amount)','event RoundPaid(uint256 indexed roundId,bytes32 ledgerHash,uint256 twapCloseX96,uint256 totalEligibleLoss)']);
export const distributorAbi=parseAbi(['function pending(address account) view returns(uint256)','function claim(address account)']);
export function temp(){mkdirSync('test/scratch',{recursive:true});return mkdtempSync(resolve('test/scratch/run-'));}
export function config():Config {
  const dataDir=temp();
  return {launch:{chainId:4663,token:A(1),poolManager:A(2),poolId:H(3),hook:A(4),distributor:A(5),router:A(6),roundPayout:A(7),payoutWallet:A(8),deployer:A(9),factory:A(10),launchBlock:1n,launchTs:1000,launchTx:H(11),tokenDecimals:18,abis:{hook:hookAbi,roundPayout:roundAbi,distributor:distributorAbi},distributorClaim:{functionName:'claim',args:[A(8)]},distributorPending:{functionName:'pending',args:[A(8)]},ethImdPool:{poolManager:A(2),poolId:H(12),initializeBlock:1n,ethCurrency:A(13),ethDecimals:18}},
    dataDir,executor:'dry-run',rules:{...RULES,minBuy:0n,minPayout:0n,maxRecipientsPerTx:200,excluded:[]},ops:{skimFraction:0n,dexReserve:0n,stallSeconds:300,heartbeatSeconds:3600},exec:{maxRoundPayoutQuote:10n**30n,pauseFile:`${dataDir}/PAUSE`,confirmations:5,timeoutMs:1000},rpc:{urls:['http://127.0.0.1:1'],logsUrl:'http://127.0.0.1:2',priorityUrl:'http://127.0.0.1:3',pollMs:750,anchorSpacing:100n,followMargin:20n,logChunk:10000n,backoffMs:1,timeoutMs:100},api:{host:'127.0.0.1',port:8787},prices:{intervalMs:60000,coinGeckoUrl:'http://127.0.0.1:4'}};
}
export function wallet(a=alice,tokens=100n,cost=1000n){return {...emptyWallet(a),balance:tokens,qualifyingTokens:tokens,cost};}
export function event(c:Config,name:string,args:Record<string,any>,block=1,logIndex=0,tx=block,timestamp=1000+block):Event {
  const address=name==='Transfer'?c.launch.token:['Swap','Initialize'].includes(name)?c.launch.poolManager:['FeeAccrued','Swept'].includes(name)?c.launch.hook:c.launch.roundPayout;
  return {id:`${H(block)}:${H(tx)}:${logIndex}`,address,name,args,blockNumber:BigInt(block),blockHash:H(block),transactionHash:H(tx),transactionIndex:0,logIndex,timestamp};
}
export function baseEvents(c:Config,imdIs1=true):Event[]{
  return [event(c,'Transfer',{from:A(0),to:c.launch.poolManager,value:1000000n},1,0,1,1000),
    event(c,'Initialize',{id:c.launch.poolId,currency0:imdIs1?c.launch.token:IMD,currency1:imdIs1?IMD:c.launch.token,hooks:c.launch.hook,fee:12500,sqrtPriceX96:Q96,tick:0},1,1,1,1000)];
}
export function buyEvents(c:Config,to=alice,block=2,imdIs1=true,tokens=100n,imd=1000n,fee=50n):Event[]{
  return [event(c,'FeeAccrued',{isSell:false,baseFeeImd:fee,surchargeImd:0n,imdLeg:imd},block,0),
    event(c,'Swap',{id:c.launch.poolId,amount0:imdIs1?tokens:-imd,amount1:imdIs1?-imd:tokens,sqrtPriceX96:Q96},block,1),
    event(c,'Transfer',{from:c.launch.poolManager,to,value:tokens},block,2)];
}
