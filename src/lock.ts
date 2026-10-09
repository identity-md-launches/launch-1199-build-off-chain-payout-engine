import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
/** Kernel-owned lock: survives contention and releases on process/pipe death, with no stale-PID deletion race. */
export async function acquireLock(file:string):Promise<()=>Promise<void>> {
  mkdirSync(dirname(file),{recursive:true,mode:0o700});closeSync(openSync(file,'a',0o600));
  const child=spawn('flock',['--exclusive','--nonblock',file,'sh','-c','printf "locked\\n"; cat >/dev/null'],{stdio:['pipe','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{
    let accepted=false;
    child.once('error',()=>reject(new Error('flock is required')));
    child.stdout.once('data',data=>{if(String(data).trim()==='locked'){accepted=true;resolve();}});
    child.once('exit',()=>{if(!accepted)reject(new Error('Another writer holds the lock'));});
  });
  return async()=>{child.stdin.end();await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});};
}
