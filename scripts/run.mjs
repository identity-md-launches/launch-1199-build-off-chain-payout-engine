import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const entries={tsx:'tsx/dist/cli.mjs',vitest:'vitest/vitest.mjs',pm2:'pm2/bin/pm2'};
/** PM2 auto-dumps its process environment on signals, as well as on explicit save. Discard both dumps. */
export function pm2Environment(env=process.env){
  return {...env,PM2_HOME:resolve(env.PM2_HOME||resolve(env.DATA_DIR||'data','private','pm2')),PM2_DUMP_FILE_PATH:'/dev/null',PM2_DUMP_BACKUP_FILE_PATH:'/dev/null'};
}
export function verifyPm2Daemon(env){
  const file=resolve(env.PM2_HOME,'pm2.pid');if(!existsSync(file))return;
  const pid=readFileSync(file,'utf8').trim();if(!/^\d+$/.test(pid))throw new Error('Invalid pm2 PID file');
  let vars;
  try{vars=readFileSync(`/proc/${pid}/environ`,'utf8').split('\0');}catch(error){if(error.code==='ENOENT')return;throw new Error('Cannot verify pm2 dump protection');}
  if(!vars.includes('PM2_DUMP_FILE_PATH=/dev/null')||!vars.includes('PM2_DUMP_BACKUP_FILE_PATH=/dev/null'))throw new Error('Existing pm2 daemon can persist secrets. Use a fresh dedicated PM2_HOME.');
}
export function main(){
  const [, , tool, ...args]=process.argv;
  if(!entries[tool])throw new Error('Expected tsx, vitest, or pm2');
  const entry=resolve(root,'src/node_modules',entries[tool]);
  if(!existsSync(entry))execFileSync(process.execPath,[resolve(root,'scripts/install.mjs')],{stdio:'inherit'});
  const env=tool==='pm2'?pm2Environment():process.env;
  if(tool==='pm2'){
    if(!['start','stop','restart','reload','delete','kill','logs','status','list','ls','monit','ping','flush','reset','--version','-v'].includes(args[0]))throw new Error('Unsupported pm2 command: environment dumps and diagnostics are disabled');
    verifyPm2Daemon(env);
  }
  const child=spawn(process.execPath,[entry,...args],{stdio:'inherit',cwd:root,env});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
