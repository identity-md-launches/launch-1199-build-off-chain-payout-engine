import { readFileSync } from 'node:fs';
import { createPublicClient,http,decodeEventLog,parseAbi,type Address,type Hex } from 'viem';
import { pathToFileURL } from 'node:url';
import { IMD,CHAIN_ID,address,hash } from '../src/config.js';
import { POOL_ABI,TOKEN_ABI } from '../src/indexer.js';
import { canonical } from '../src/ledger.js';
export async function main(){
  const options:Record<string,string>={};for(let i=2;i<process.argv.length;i+=2)options[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
  const token=address(options.token,'token'),manager=address(options['pool-manager'],'pool-manager');
  if(!options.rpc||!/^\d+$/.test(options['from-block']||''))throw new Error('Require --token, --pool-manager, --rpc, --from-block; optionally --to-block and --pool-id');
  const client=createPublicClient({transport:http(options.rpc,{retryCount:0,timeout:15000})});
  if(await client.getChainId()!==CHAIN_ID)throw new Error('Wrong chain');
  const hasCode=async(target:Address)=>{const code=await client.getCode({address:target});return Boolean(code&&code!=='0x');};
  if(!await hasCode(token)||!await hasCode(manager))throw new Error('Token or manager has no code');
  const from=BigInt(options['from-block']),to=options['to-block']?BigInt(options['to-block']):await client.getBlockNumber();
  const range=async(filter:any,a:bigint,b:bigint):Promise<any[]>=>{try{return await client.getLogs({...filter,fromBlock:a,toBlock:b});}catch{if(a===b)throw new Error('RPC refused one block');const mid=(a+b)/2n;return [...await range(filter,a,mid),...await range(filter,mid+1n,b)];}};
  const inits:any[]=[];
  for(let a=from;a<=to;a+=10000n){const b=a+9999n<to?a+9999n:to;
    // currency positions are indexed independently; either may contain MONEYBACK.
    for(const position of ['currency0','currency1'])inits.push(...await range({address:manager,event:POOL_ABI[0],args:{[position]:token}},a,b));
  }
  const candidates=inits.map(log=>({log,decoded:decodeEventLog({abi:POOL_ABI,data:log.data,topics:log.topics}) as any})).filter(({decoded:d})=>[d.args.currency0.toLowerCase(),d.args.currency1.toLowerCase()].includes(IMD.toLowerCase())&&Number(d.args.fee)===12500&&(!options['pool-id']||d.args.id.toLowerCase()===hash(options['pool-id'])));
  if(candidates.length!==1)throw new Error('Expected one MONEYBACK/IMD pool; narrow the block range or supply --pool-id');
  const {log,decoded}=candidates[0],hook=address(decoded.args.hooks),receipt=await client.getTransactionReceipt({hash:log.transactionHash}),header=await client.getBlock({blockNumber:log.blockNumber});
  const discovered:Record<string,unknown>={chainId:CHAIN_ID,token,poolManager:manager,poolId:decoded.args.id,hook,launchBlock:log.blockNumber.toString(),launchTs:Number(header.timestamp),launchTx:log.transactionHash,deployer:receipt.from,
    tokenDecimals:Number(await client.readContract({address:token,abi:TOKEN_ABI,functionName:'decimals'})),currency0:decoded.args.currency0,currency1:decoded.args.currency1};
  if(!await hasCode(hook))throw new Error('Hook has no code');
  const mintLogs:any[]=[];
  for(let a=from;a<=log.blockNumber;a+=10000n){const b=a+9999n<log.blockNumber?a+9999n:log.blockNumber;
    mintLogs.push(...await range({address:token,event:TOKEN_ABI[0],args:{from:'0x0000000000000000000000000000000000000000'}},a,b));}
  if(mintLogs.length)discovered.launchBlock=mintLogs.reduce((n,l)=>l.blockNumber<n?l.blockNumber:n,log.blockNumber).toString();
  const eventFields:Record<string,Address>={};
  if(options['factory-abi']){
    const factoryAbi=JSON.parse(readFileSync(options['factory-abi'],'utf8'));
    for(const entry of receipt.logs)try{const decoded:any=decodeEventLog({abi:factoryAbi,data:entry.data,topics:entry.topics});
      if(String(decoded.args.token||decoded.args.moneyBackToken).toLowerCase()!==token)continue;
      for(const name of ['factory','distributor','router','roundPayout','payoutWallet','deployer'])if(decoded.args[name])eventFields[name]=address(decoded.args[name]);
      eventFields.factory??=entry.address;
    }catch{}
  }
  const targets=[token,hook,...(receipt.to?[receipt.to]:[])];
  for(const name of ['factory','distributor','router','roundPayout','payoutWallet']){
    const found=new Set<string>();if(eventFields[name])found.add(eventFields[name]);
    for(const target of targets)try{const abi=parseAbi([`function ${name}() view returns (address)`]);const result=address(await client.readContract({address:target,abi,functionName:name}));
      if(name==='payoutWallet'||await hasCode(result))found.add(result);
    }catch{}
    if(name==='distributor')for(const target of targets)for(const getter of ['distributor','distributors','distributorOf','getDistributor'])try{
      const abi=parseAbi([`function ${getter}(address token) view returns (address)`]);const result=address(await client.readContract({address:target,abi,functionName:getter,args:[token]}));if(await hasCode(result))found.add(result);
    }catch{}
    discovered[name]=found.size===1?[...found][0]:`<supply verified ${name}>`;
  }
  if(eventFields.deployer)discovered.deployer=eventFields.deployer;
  discovered.abis='<supply verified hook, roundPayout and distributor JSON ABIs>';
  discovered.distributorClaim='<supply functionName and current Merkle claim args>';
  discovered.distributorPending='<supply functionName and args>';
  discovered.ethImdPool='<supply poolManager, poolId, initializeBlock, ethCurrency, ethDecimals>';
  discovered.discoveryNote='Verify token genesis is included by launchBlock; metadata without a getter must come from the launch transaction/factory ABI. Do not deploy or run with placeholders.';
  console.log(canonical(discovered));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Discovery incomplete: verify arguments, RPC, range and unique pool; no addresses were guessed');process.exitCode=1;});
