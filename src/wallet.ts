import { existsSync } from 'node:fs';
import { createWalletClient, http, keccak256, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from './config.js';
import { canonical, Store } from './ledger.js';
import { chain, RPC } from './rpc.js';
import type { ContractCall } from './fees.js';
export class SendPaused extends Error {constructor(){super('Sending is paused');this.name='SendPaused';}}
export class SendPending extends Error {constructor(){super('Transaction confirmation pending; retain journal and retry');this.name='SendPending';}}
export class SendReverted extends Error {constructor(){super('Transaction reverted; inspect the recorded transaction hash');this.name='SendReverted';}}
type Operation={fingerprint:string;nonce:number;hash:Hex;serialized?:Hex;receipt?:TransactionReceipt};
export class Wallet {
  private operations:Record<string,Operation>;private client:any;readonly address:Hex;
  private constructor(readonly c:Config,readonly rpc:RPC,private readonly store:Store,account:ReturnType<typeof privateKeyToAccount>){
    this.address=account.address;this.client=createWalletClient({account,chain,transport:http(c.rpc.priorityUrl,{retryCount:0,timeout:c.rpc.timeoutMs}),pollingInterval:c.rpc.pollMs});
    this.operations=store.read('private/transactions.json',{});
  }
  static fromEnvironment(c:Config,rpc:RPC,store=rpc.store):Wallet {
    if(c.executor!=='live')throw new Error('Dry-run must not instantiate a signer');
    const secret=process.env.PAYOUT_PRIVATE_KEY;
    if(!secret||!/^0x[0-9a-fA-F]{64}$/.test(secret))throw new Error('PAYOUT_PRIVATE_KEY is required for live execution');
    let account:ReturnType<typeof privateKeyToAccount>;
    try{account=privateKeyToAccount(secret as Hex);}catch{throw new Error('Invalid PAYOUT_PRIVATE_KEY');}
    if(account.address.toLowerCase()!==c.launch.payoutWallet.toLowerCase())throw new Error('Signer does not match launch payoutWallet');
    return new Wallet(c,rpc,store,account);
  }
  private save(){this.store.write('private/transactions.json',this.operations);}
  assertUnpaused(){if(existsSync(this.c.exec.pauseFile))throw new SendPaused();}
  async send(id:string,call:ContractCall):Promise<TransactionReceipt> {
    const fingerprint=canonical({to:call.to.toLowerCase(),data:call.data,value:call.value||0n});
    let op=this.operations[id];
    if(op&&op.fingerprint!==fingerprint)throw new Error('Operation ID reused with different calldata');
    if(!op) {
      this.assertUnpaused();
      if(await this.rpc.priority.getChainId()!==chain.id)throw new Error('Priority RPC chain mismatch');
      const pending=await this.rpc.priority.getTransactionCount({address:this.address,blockTag:'pending'});
      const local=Object.values(this.operations).reduce((n,o)=>Math.max(n,o.nonce+1),0);
      const nonce=Math.max(pending,local);
      try {
        const request=await this.client.prepareTransactionRequest({account:this.client.account,to:call.to,data:call.data,value:call.value||0n,nonce});
        const serialized=await this.client.signTransaction(request);
        op={fingerprint,nonce,hash:keccak256(serialized),serialized};
      } catch {throw new Error('Transaction preparation failed');}
      this.operations[id]=op;this.save(); // Persist the signed intent BEFORE broadcasting. It cannot create a second nonce on recovery.
    }
    let receipt:TransactionReceipt|undefined;
    try{receipt=await this.rpc.priority.getTransactionReceipt({hash:op.hash});}catch{}
    if(!receipt) {
      if(!op.serialized)throw new Error('Confirmed transaction disappeared; chain reconciliation required');
      this.assertUnpaused();
      try{await this.rpc.priority.sendRawTransaction({serializedTransaction:op.serialized});}catch{}
    }
    try{receipt=await this.rpc.priority.waitForTransactionReceipt({hash:op.hash,confirmations:this.c.exec.confirmations,timeout:this.c.exec.timeoutMs,pollingInterval:this.c.rpc.pollMs});}
    catch{throw new SendPending();}
    if(!receipt)throw new SendPending();
    if(op.receipt&&op.receipt.blockHash!==receipt.blockHash)throw new Error('Transaction receipt changed after confirmation');
    op.receipt=receipt;delete op.serialized;this.save();
    if(receipt.status!=='success')throw new SendReverted();
    return receipt;
  }
}
