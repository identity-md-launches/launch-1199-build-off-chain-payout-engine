import { it,expect } from 'vitest';
import { createRequire } from 'node:module';
import { pm2Environment } from '../scripts/run.mjs';
const require=createRequire(import.meta.url);
it('forces PM2 manual and automatic environment dumps into /dev/null',()=>{
 const env=pm2Environment({DATA_DIR:'test/scratch/pm2',PM2_DUMP_FILE_PATH:'unsafe',PM2_DUMP_BACKUP_FILE_PATH:'unsafe-backup'});
 expect(env.PM2_DUMP_FILE_PATH).toBe('/dev/null');expect(env.PM2_DUMP_BACKUP_FILE_PATH).toBe('/dev/null');
 const previous={PM2_HOME:process.env.PM2_HOME,PM2_DUMP_FILE_PATH:process.env.PM2_DUMP_FILE_PATH,PM2_DUMP_BACKUP_FILE_PATH:process.env.PM2_DUMP_BACKUP_FILE_PATH};
 try{Object.assign(process.env,env);const actualPaths=require('pm2/paths.js')();expect(actualPaths.DUMP_FILE_PATH).toBe('/dev/null');expect(actualPaths.DUMP_BACKUP_FILE_PATH).toBe('/dev/null');}
 finally{for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;delete process.env.DATA_DIR;}
});
