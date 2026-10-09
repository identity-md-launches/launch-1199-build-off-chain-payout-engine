import { Store } from './ledger.js';
export type AlertKind='paid'|'failed'|'stalled'|'heartbeat'|'refused';
export class Alerts {
  constructor(readonly store:Store,private readonly env:NodeJS.ProcessEnv=process.env){}
  async send(kind:AlertKind,detail:{epoch?:number;amount?:string;count?:number;reason?:string}={}):Promise<void> {
    // Only caller-created summaries reach logs/Telegram. Never stringify RPC errors, accounts or environment objects.
    const item={kind,...detail,at:new Date().toISOString()};
    console.log(JSON.stringify(item));
    this.store.write('private/last-alert.json',item);
    const token=this.env.TELEGRAM_BOT_TOKEN,chat=this.env.TELEGRAM_CHAT_ID;
    if(!token||!chat)return;
    try {
      const result=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text:`MONEYBACK ${JSON.stringify(item)}`}),signal:AbortSignal.timeout(10000)});
      if(!result.ok)console.error('Telegram delivery failed');
    } catch {console.error('Telegram delivery unavailable');}
  }
}
