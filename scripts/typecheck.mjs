import { spawnSync,execFileSync } from 'node:child_process';
import { readdirSync,existsSync } from 'node:fs';
if(!existsSync('src/node_modules/typescript/bin/tsc'))execFileSync(process.execPath,['scripts/install.mjs'],{stdio:'inherit'});
const files=['src','scripts','test'].flatMap(dir=>readdirSync(dir).filter(f=>f.endsWith('.ts')).map(f=>`${dir}/${f}`));
const result=spawnSync(process.execPath,['src/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--types','node','--typeRoots','src/node_modules/@types',...files],{stdio:'inherit'});
process.exitCode=result.status??1;
