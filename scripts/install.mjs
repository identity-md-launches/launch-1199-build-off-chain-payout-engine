import { createHash } from 'node:crypto';
import { readFileSync, existsSync, symlinkSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='linux'||process.arch!=='x64')throw new Error('This offline runtime is built for Linux x86-64. Rebuild the vendored archive for another platform.');
const archive=resolve(root,'scripts/vendor/runtime-linux-x64.tar.xz');
const expected=readFileSync(resolve(root,'scripts/vendor/runtime.sha256'),'utf8').split(/\s+/)[0];
const actual=createHash('sha256').update(readFileSync(archive)).digest('hex');
if(expected!==actual)throw new Error('Vendored dependency checksum mismatch');
const staging=mkdtempSync(resolve(root,'src/.runtime-'));
try {
  execFileSync('tar',['-xJf',archive,'-C',staging]);
  rmSync(resolve(root,'src/node_modules'),{recursive:true,force:true});
  renameSync(resolve(staging,'node_modules'),resolve(root,'src/node_modules'));
} finally {
  rmSync(staging,{recursive:true,force:true});
}
for(const dir of ['test','scripts']) {
  const destination=resolve(root,dir,'node_modules');
  if(!existsSync(destination))symlinkSync('../src/node_modules',destination,'dir');
}
console.log('Installed pinned offline runtime in src/node_modules. No network was used.');
