import { existsSync } from 'node:fs';
import { decodeEventLog, decodeFunctionData, encodeFunctionData, type Address, type Hex, type TransactionReceipt } from 'viem';
import { IMD, type Config } from './config.js';
import { eligibility } from './eligibility.js';
import { twap,epochIndex,epochClose } from './twap.js';
import { TOKEN_ABI,rebuild,type IndexState } from './indexer.js';
import { chunks, type Chunk, type DropLedger } from './payout.js';
import { Store, ledgerHash } from './ledger.js';
import { Wallet, SendPaused } from './wallet.js';
import { RPC } from './rpc.js';
import type { WriteOffReceipt } from './fees.js';
import type { Alerts } from './alerts.js';
export class FundingPending extends Error {constructor(){super('Funding proof incomplete or priority balance stale; retry safely');this.name='FundingPending';}}
export type Evidence={ledgerHash:Hex;legs:{to:Address;amount:bigint;failed:boolean}[]};
export interface ExecutorChain {
  validateRecipients?(chunk:Chunk):Promise<void>;
  validateRetry?(roundId:bigint,to:Address[]):Promise<void>;
  paused():Promise<boolean>; isPaid(roundId:bigint):Promise<boolean>; evidence(roundId:bigint):Promise<Evidence>;
  balance():Promise<bigint>; fund(amount:bigint,id:string):Promise<TransactionReceipt>;
  fundingProof(receipt:TransactionReceipt,amount:bigint):Promise<boolean>;
  pay(chunk:Chunk,id:string):Promise<void>; failed(roundId:bigint,to:Address):Promise<bigint>;
  retry(roundId:bigint,to:Address[],id:string):Promise<void>; writeOff(roundId:bigint,to:Address,id:string):Promise<void>;
}
type FundingAccount={credits:Record<string,bigint>;debits:Record<string,bigint>};
type Execution={ledgerHash:Hex;fundAmount?:bigint;fundReceipt?:TransactionReceipt;complete:boolean;chunks:string[]};
const sum=(values:bigint[])=>values.reduce((s,n)=>s+n,0n);
export class Executor {
  private account:FundingAccount;
  constructor(readonly c:Config,readonly chain:ExecutorChain|undefined,readonly store:Store,readonly alerts:Pick<Alerts,'send'>){
    this.account=store.read('private/funding-account.json',{credits:{},debits:{}});
  }
  creditWriteOffs(refunds:readonly WriteOffReceipt[]){
    for(const r of refunds){if(this.account.debits[r.roundId.toString()]===undefined)continue;
      const id=`writeOff:${r.roundId}:${r.to.toLowerCase()}`;this.account.credits[id]=r.amount;}
    this.save();
  }
  private save(){this.store.write('private/funding-account.json',this.account);}
  private async gate(){if(existsSync(this.c.exec.pauseFile))throw new SendPaused();if(await this.chain!.paused())throw new SendPaused();}
  async execute(ledger:DropLedger):Promise<{dryRun:boolean;failed:number}> {
    const parts=chunks(ledger,this.c.rules.maxRecipientsPerTx),total=sum(ledger.payees.map(p=>p.amount));
    if(total>this.c.exec.maxRoundPayoutQuote){await this.alerts.send('refused',{epoch:ledger.epochIndex,reason:'maxRoundPayoutQuote exceeded'});throw new Error('Round exceeds configured maximum');}
    if(this.c.executor==='dry-run')return {dryRun:true,failed:0};
    if(!this.chain)throw new Error('Missing live executor chain');
    const name=`private/execution-${ledger.epochIndex}.json`,hash=ledgerHash(ledger);
    const state=this.store.read<Execution>(name,{ledgerHash:hash,complete:false,chunks:[]});
    if(state.ledgerHash!==hash)throw new Error('Prepared ledger changed');
    const save=()=>this.store.write(name,state);
    save();await this.gate();
    let failed=0;
    const settle=async(part:Chunk)=>{
      const evidence=await this.chain!.evidence(part.roundId);
      if(evidence.ledgerHash!==part.ledgerHash||evidence.legs.length!==part.payees.length)throw new Error('On-chain round does not match ledger');
      const seen=new Set<string>();
      for(const p of part.payees) {
        const leg=evidence.legs.find(x=>x.to.toLowerCase()===p.payee.toLowerCase());
        if(!leg||leg.amount!==p.amount||seen.has(leg.to.toLowerCase()))throw new Error('On-chain payee mismatch');
        seen.add(leg.to.toLowerCase());if(await this.chain!.failed(part.roundId,p.payee)>0n)failed++;
      }
      this.account.debits[part.roundId.toString()]=sum(part.payees.map(p=>p.amount));this.save();
      if(!state.chunks.includes(part.roundId.toString()))state.chunks.push(part.roundId.toString());save();
    };
    // Reconcile chain state first, including a transaction mined just before a previous process died.
    const unpaid:Chunk[]=[];
    for(const part of parts)if(await this.chain.isPaid(part.roundId))await settle(part);else unpaid.push(part);
    const needed=sum(unpaid.flatMap(p=>p.payees.map(x=>x.amount)));
    const net=sum(Object.values(this.account.credits))-sum(Object.values(this.account.debits));
    const available=net>0n?net:0n;
    if(state.fundAmount===undefined){state.fundAmount=needed>available?needed-available:0n;save();}
    const fundId=`epoch:${ledger.epochIndex}:fund`;
    if(state.fundAmount>0n&&!this.account.credits[fundId]) {
      await this.gate();
      const receipt=state.fundReceipt||await this.chain.fund(state.fundAmount,fundId);
      state.fundReceipt=receipt;save();
      if(!await this.chain.fundingProof(receipt,state.fundAmount))throw new FundingPending();
      this.account.credits[fundId]=state.fundAmount;this.save();
    }
    // Even on restart, funding requires both the original receipt and a priority-node read.
    if(state.fundAmount>0n&&state.fundReceipt&&!await this.chain.fundingProof(state.fundReceipt,state.fundAmount))throw new FundingPending();
    for(let i=0;i<unpaid.length;i++) {
      const part=unpaid[i];await this.gate();
      // Re-check immediately before EACH send; never rely on the earlier batch query.
      if(await this.chain.isPaid(part.roundId)){await settle(part);continue;}
      if(this.chain.validateRecipients)await this.chain.validateRecipients(part);
      const remaining=sum(unpaid.slice(i).flatMap(p=>p.payees.map(x=>x.amount)));
      if(await this.chain.balance()<remaining)throw new FundingPending();
      await this.gate();
      if(await this.chain.isPaid(part.roundId)){await settle(part);continue;}
      await this.chain.pay(part,`epoch:${ledger.epochIndex}:pay:${part.chunkIndex}`);
      if(!await this.chain.isPaid(part.roundId))throw new FundingPending();
      await settle(part);
    }
    state.complete=true;save();
    await this.alerts.send(failed?'failed':'paid',{epoch:ledger.epochIndex,amount:total.toString(),count:failed||ledger.payees.length});
    return {dryRun:false,failed};
  }
  async retryFailed(roundId:bigint,to:Address[],attempt:number):Promise<void> {
    if(this.c.executor!=='live'||!this.chain)throw new Error('Retry requires live mode');
    await this.gate();
    const recipients:Address[]=[];for(const address of [...new Set(to)])if(await this.chain.failed(roundId,address)>0n)recipients.push(address);
    if(recipients.length){if(this.chain.validateRetry)await this.chain.validateRetry(roundId,recipients);await this.gate();await this.chain.retry(roundId,recipients,`retry:${roundId}:${attempt}`);
      let failed=0;for(const to of recipients)if(await this.chain.failed(roundId,to)>0n)failed++;
      await this.alerts.send(failed?'failed':'paid',{epoch:Number(roundId/1000n),count:failed||recipients.length});}
  }
  async writeOffFailed(roundId:bigint,to:Address):Promise<void> {
    if(this.c.executor!=='live'||!this.chain)throw new Error('Write-off requires live mode');
    await this.gate();const id=`writeOff:${roundId}:${to.toLowerCase()}`;
    const intent=this.store.read<{amount:bigint}|null>(`private/${id}.json`,null);
    const amount=intent?.amount??await this.chain.failed(roundId,to);if(amount===0n)return;
    this.store.write(`private/${id}.json`,{amount});
    await this.chain.writeOff(roundId,to,id);
    if(await this.chain.failed(roundId,to)!==0n)throw new Error('Write-off not confirmed');
    this.account.credits[id]=amount;this.save();
  }
}
export class LiveChain implements ExecutorChain {
  private guardCache?:{key:string;state:ReturnType<typeof rebuild>};
  constructor(readonly c:Config,readonly rpc:RPC,readonly wallet:Wallet,readonly indexed?:()=>IndexState){}
  private read(functionName:string,args:unknown[]=[]):Promise<any>{return this.rpc.priority.readContract({address:this.c.launch.roundPayout,abi:this.c.launch.abis.roundPayout,functionName,args});}
  private async send(functionName:string,args:unknown[],id:string):Promise<TransactionReceipt>{
    return this.wallet.send(id,{to:this.c.launch.roundPayout,data:encodeFunctionData({abi:this.c.launch.abis.roundPayout,functionName,args} as any)});
  }
  async validateRecipients(part:Chunk){
    const index=this.indexed?.()||this.rpc.store.read<IndexState|null>('private/indexer.json',null);
    if(!index)throw new Error('No indexed eligibility state');
    const key=`${index.head}:${index.events.length}:${index.contracts.join(',')}`;
    if(this.guardCache?.key!==key)this.guardCache={key,state:rebuild(index.events,this.c,new Set(index.contracts))};
    const state=this.guardCache!.state;
    const header=await this.rpc.priority.getBlock({blockTag:'latest'}),head=BigInt(header.number);
    const epoch=Number(part.roundId/1000n),expires=this.c.launch.launchTs+(epoch+1)*900;
    if(Number(header.timestamp)>=expires)throw new Error('Prepared round is stale; review its unsent chunks');
    const recipients=new Set(part.payees.map(p=>p.payee.toLowerCase()));
    const recent=await this.rpc.logs({address:this.c.launch.token,event:TOKEN_ABI[0],args:{from:[...recipients]}},index.head+1n,head,this.rpc.priority);
    for(const log of recent){const d:any=decodeEventLog({abi:TOKEN_ABI,data:log.data,topics:log.topics as any});if(d.args.value>0n&&d.args.from.toLowerCase()!==d.args.to.toLowerCase())throw new Error('Recipient had an outflow after indexing');}
    for(let i=0;i<part.payees.length;i+=8)await Promise.all(part.payees.slice(i,i+8).map(async p=>{
      const w=state.wallets.get(p.payee.toLowerCase());
      if(!w||w.disqualified||w.balance<w.qualifyingTokens)throw new Error('Prepared recipient is no longer eligible');
      const [code,balance]=await Promise.all([this.rpc.priority.getCode({address:p.payee,blockNumber:head}),this.rpc.priority.readContract({address:this.c.launch.token,abi:TOKEN_ABI,functionName:'balanceOf',args:[p.payee],blockNumber:head})]);
      if((code&&code!=='0x')||BigInt(balance)<w.qualifyingTokens)throw new Error('Recipient has code or lacks qualifying tokens');
    }));
  }
  async validateRetry(roundId:bigint,to:Address[]){
    const index=this.indexed?.()||this.rpc.store.read<IndexState|null>('private/indexer.json',null);
    if(!index)throw new Error('Index before retrying');
    const header=await this.rpc.priority.getBlock({blockNumber:index.head}),epoch=epochIndex(this.c.launch.launchTs,Number(header.timestamp));
    if(epoch<1)throw new Error('No closed epoch for retry');
    const closeTs=epochClose(this.c.launch.launchTs,epoch),codes=new Set(index.contracts);
    const historical=rebuild(index.events.filter(e=>e.timestamp<closeTs),this.c,codes),current=rebuild(index.events,this.c,codes),close=twap(historical.observations,closeTs);
    const payees=[];
    for(const address of to){
      const w=historical.wallets.get(address.toLowerCase()),now=current.wallets.get(address.toLowerCase()),amount=await this.failed(roundId,address);
      if(!w||!now||now.reserved<amount)throw new Error('Retry state is not fully indexed');
      const e=eligibility({...w,disqualified:w.disqualified||now.disqualified,reason:now.reason||w.reason,paid:now.paid,reserved:now.reserved-amount},close,this.c.rules.minBuy);
      if(!e.eligible||amount>e.cap)throw new Error('Retry would violate current eligibility or loss caps; retain or write off the reservation');
      payees.push({payee:address,loss:e.loss,entry:e.entry,close,amount});
    }
    await this.validateRecipients({roundId:BigInt(epoch)*1000n,chunkIndex:0,payees,ledgerHash:'0x',twapCloseX96:close,totalEligibleLoss:payees.reduce((s,p)=>s+p.loss,0n)});
  }
  async verifyOwner(){if(String(await this.read('owner')).toLowerCase()!==this.c.launch.payoutWallet.toLowerCase())throw new Error('RoundPayout owner mismatch');}
  async paused(){const value=await this.read('paused');if(typeof value!=='boolean')throw new Error('Invalid paused() ABI');return value;}
  async isPaid(roundId:bigint){const value=await this.read('isPaid',[roundId]);if(typeof value!=='boolean')throw new Error('Invalid isPaid() ABI');return value;}
  async balance(){return BigInt(await this.rpc.priority.readContract({address:IMD,abi:TOKEN_ABI,functionName:'balanceOf',args:[this.c.launch.roundPayout]}));}
  async failed(roundId:bigint,to:Address){return BigInt(await this.read('failed',[roundId,to]));}
  async fund(amount:bigint,id:string):Promise<TransactionReceipt>{
    const allowance=BigInt(await this.rpc.priority.readContract({address:IMD,abi:TOKEN_ABI,functionName:'allowance',args:[this.c.launch.payoutWallet,this.c.launch.roundPayout]}));
    if(allowance<amount) {
      if(allowance>0n)await this.wallet.send(`${id}:reset`,{to:IMD,data:encodeFunctionData({abi:TOKEN_ABI,functionName:'approve',args:[this.c.launch.roundPayout,0n]})});
      await this.wallet.send(`${id}:approve`,{to:IMD,data:encodeFunctionData({abi:TOKEN_ABI,functionName:'approve',args:[this.c.launch.roundPayout,amount]})});
    }
    return this.send('fund',[IMD,amount],id);
  }
  async fundingProof(receipt:TransactionReceipt,amount:bigint):Promise<boolean>{
    if(receipt.status!=='success')return false;
    const actual=await this.rpc.priority.getTransactionReceipt({hash:receipt.transactionHash});
    if(actual.blockHash!==receipt.blockHash||actual.status!=='success')return false;
    let event=false,transfer=0n;
    for(const log of actual.logs)try{
      if(log.address.toLowerCase()===this.c.launch.roundPayout.toLowerCase()){
        const d:any=decodeEventLog({abi:this.c.launch.abis.roundPayout,data:log.data,topics:log.topics});
        if(d.eventName==='Funded'&&String(d.args.token).toLowerCase()===IMD.toLowerCase()&&BigInt(d.args.amount)===amount)event=true;
      }else if(log.address.toLowerCase()===IMD.toLowerCase()){
        const d:any=decodeEventLog({abi:TOKEN_ABI,data:log.data,topics:log.topics});
        if(d.eventName==='Transfer'&&d.args.from.toLowerCase()===this.c.launch.payoutWallet.toLowerCase()&&d.args.to.toLowerCase()===this.c.launch.roundPayout.toLowerCase())transfer+=d.args.value;
      }
    }catch{}
    if(!event||transfer!==amount)return false;
    // Historical balance proves receipt funding even after this round has spent some/all of it.
    const head=await this.rpc.priority.getBlockNumber({cacheTime:0});
    if(head<receipt.blockNumber+BigInt(this.c.exec.confirmations)-1n)return false;
    const funded=await this.rpc.priority.readContract({address:IMD,abi:TOKEN_ABI,functionName:'balanceOf',args:[this.c.launch.roundPayout],blockNumber:receipt.blockNumber});
    return BigInt(funded)>=amount;
  }
  async pay(part:Chunk,id:string){await this.send('payRound',[part.roundId,IMD,part.payees.map(p=>p.payee),part.payees.map(p=>p.amount),part.ledgerHash,part.twapCloseX96,part.totalEligibleLoss],id);}
  async evidence(roundId:bigint):Promise<Evidence>{
    const operationId=`epoch:${roundId/1000n}:pay:${roundId%1000n}`;
    const operations=this.rpc.store.read<Record<string,{hash:Hex}>>('private/transactions.json',{});
    const indexed=this.indexed?.();
    let transactionHash=operations[operationId]?.hash||indexed?.events.find(e=>e.name==='RoundPaid'&&e.address.toLowerCase()===this.c.launch.roundPayout.toLowerCase()&&BigInt(e.args.roundId)===roundId)?.transactionHash;
    if(!transactionHash){
      const event=this.c.launch.abis.roundPayout.find((x:any)=>x.type==='event'&&x.name==='RoundPaid');
      const head=await this.rpc.priority.getBlockNumber({cacheTime:0});
      const logs=await this.rpc.logs({address:this.c.launch.roundPayout,event,args:{roundId}},this.c.launch.launchBlock,head,this.rpc.priority);
      const matches=logs.filter(log=>{try{const d:any=decodeEventLog({abi:this.c.launch.abis.roundPayout,data:log.data,topics:log.topics as any});return d.eventName==='RoundPaid'&&BigInt(d.args.roundId)===roundId;}catch{return false;}});
      if(matches.length!==1)throw new Error('Missing or duplicate RoundPaid evidence');transactionHash=matches[0].transactionHash;
    }
    const receipt=await this.rpc.priority.getTransactionReceipt({hash:transactionHash});
    const transaction=await this.rpc.priority.getTransaction({hash:transactionHash});
    if(transaction.to?.toLowerCase()!==this.c.launch.roundPayout.toLowerCase()||transaction.from.toLowerCase()!==this.c.launch.payoutWallet.toLowerCase())throw new Error('RoundPaid transaction has unexpected caller or target');
    const decoded:any=decodeFunctionData({abi:this.c.launch.abis.roundPayout,data:transaction.input});
    if(decoded.functionName!=='payRound'||BigInt(decoded.args[0])!==roundId||String(decoded.args[1]).toLowerCase()!==IMD.toLowerCase())throw new Error('RoundPaid was not an IMD payRound');
    const result:Evidence={ledgerHash:'0x',legs:[]};
    for(const log of receipt.logs) {
      if(log.address.toLowerCase()!==this.c.launch.roundPayout.toLowerCase())continue;
      try{const d:any=decodeEventLog({abi:this.c.launch.abis.roundPayout,data:log.data,topics:log.topics});
        if(BigInt(d.args.roundId)!==roundId)continue;
        if(d.eventName==='RoundPaid')result.ledgerHash=d.args.ledgerHash;
        if(d.eventName==='Paid'||d.eventName==='PayFailed')result.legs.push({to:d.args.to,amount:BigInt(d.args.amount),failed:d.eventName==='PayFailed'});
      }catch{}
    }
    return result;
  }
  async retry(roundId:bigint,to:Address[],id:string){await this.send('retryFailed',[roundId,to],id);}
  async writeOff(roundId:bigint,to:Address,id:string){
    const receipt=await this.send('writeOffFailed',[roundId,to],id);
    const found=receipt.logs.some(log=>{if(log.address.toLowerCase()!==this.c.launch.roundPayout.toLowerCase())return false;
      try{const d:any=decodeEventLog({abi:this.c.launch.abis.roundPayout,data:log.data,topics:log.topics});return d.eventName==='WrittenOff'&&BigInt(d.args.roundId)===roundId&&d.args.to.toLowerCase()===to.toLowerCase();}catch{return false;}});
    if(!found)throw new Error('Missing WrittenOff evidence');
  }
}
