// Maintainer tool. Input is a fresh npm ci tree made from the vendored lockfile.
// Service installation uses only install.mjs and never runs npm or this script.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/pack-runtime.mjs DIRECTORY_CONTAINING_NODE_MODULES');
const input = resolve(process.argv[2], 'node_modules');
const scratch = join(root, 'test/scratch');
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, 'package-runtime-'));
const destination = join(work, 'node_modules');
const archive = join(work, 'runtime-linux-x64.tar.xz');
const { transform } = await import(pathToFileURL(join(input, 'esbuild/lib/main.js')).href);
const { default: ts } = await import(pathToFileURL(join(input, 'typescript/lib/typescript.js')).href);
const printer = ts.createPrinter({ removeComments: true });
const expected = JSON.parse(readFileSync(join(root, 'scripts/vendor/dependencies.lock.json'), 'utf8'));
for (const [path, metadata] of Object.entries(expected.packages)) {
  if (!path || !existsSync(resolve(input, '..', path))) continue; // Other OS optional binaries.
  const actual = JSON.parse(readFileSync(resolve(input, '..', path, 'package.json'), 'utf8'));
  if (actual.version !== metadata.version || (metadata.name && actual.name !== metadata.name)) {
    throw new Error(`Dependency version mismatch: ${path}`);
  }
}
if (JSON.parse(readFileSync(join(input, 'esbuild/package.json'), 'utf8')).name !== 'esbuild-wasm') {
  throw new Error('Expected the pinned esbuild-wasm alias, not a second native esbuild');
}
let removed = 0, minified = 0, declarations = 0;
const omit = new Set([
  '.package-lock.json', '.bin/tsserver', 'typescript/bin/tsserver',
  'viem/trusted-setups/mainnet.json', 'viem/trusted-setups/minimal.json',
  'ox/trusted-setups/internal/setups/mainnet.json', 'ox/trusted-setups/internal/setups/mainnet.txt',
]);
async function visit(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), rel = relative(destination, path);
    const stat = lstatSync(path);
    if (stat.isDirectory()) { await visit(path); continue; }
    const parts = rel.split('/');
    const packageEnd = parts[0].startsWith('@') ? 2 : 1;
    const local = parts.slice(packageEnd);
    const license = /^(license|licence|copying|notice)/i.test(name);
    // Restrict documentation matching to text files: pidusage/lib/history.js is runtime code.
    const documentation = /^(readme|changelog|history|changes|contributing)(\.(md|markdown|txt))?$/i.test(name);
    // Only package-root development directories; viem/_esm/actions/test is a runtime API.
    const development = ['test', 'tests', '__tests__', 'example', 'examples', 'docs', '.github'].includes(local[0]);
    const drop = !license && (
      omit.has(rel) || name.endsWith('.map') || documentation || development ||
      rel.startsWith('@pm2/js-api/dist/') ||
      rel.startsWith('typescript/lib/') && name === 'diagnosticMessages.generated.json' ||
      ['viem', 'ox', 'abitype'].includes(parts[0]) && name.endsWith('.ts') && !name.endsWith('.d.ts') ||
      rel.startsWith('typescript/lib/') && name.endsWith('.js') && !['tsc.js', '_tsc.js'].includes(name)
    );
    if (drop) { rmSync(path); removed++; continue; }
    if (!stat.isFile()) continue;
    if (/\.d\.(ts|mts|cts)$/.test(name)) {
      const source = ts.createSourceFile(name, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      if (source.parseDiagnostics.length) throw new Error(`Invalid declaration: ${rel}`);
      writeFileSync(path, printer.printFile(source));
      declarations++;
    } else if (/\.(js|mjs|cjs)$/.test(name) && !rel.startsWith('esbuild/lib/')) {
      // esbuild/lib's dead-code annotations are required for Node's CJS named export detection.
      const result = await transform(readFileSync(path, 'utf8'), {
        minify: true, keepNames: true, legalComments: 'inline', platform: 'node', target: 'node22',
      });
      writeFileSync(path, result.code);
      minified++;
    }
  }
}
try {
  cpSync(input, destination, { recursive: true, verbatimSymlinks: true });
  await visit(destination);
  const tar = join(work, 'runtime.tar');
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--mode=u+rwX,go+rX', '-cf', tar, '-C', work, 'node_modules']);
  const { openSync, closeSync } = await import('node:fs');
  const fd = openSync(archive, 'w');
  try {
    const child = spawn('xz', ['--x86', '--lzma2=preset=9e,dict=64MiB', '-T1', '-c', tar], { stdio: ['ignore', fd, 'inherit'] });
    await new Promise((accept, reject) => {
      child.on('error', reject);
      child.on('exit', code => code === 0 ? accept() : reject(new Error(`xz exited ${code}`)));
    });
  } finally { closeSync(fd); }
  const bytes = statSync(archive).size;
  if (bytes > 8 * 1024 * 1024 - 350_000) throw new Error('Runtime leaves insufficient room in the 8 MiB source bundle');
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  renameSync(archive, join(root, 'scripts/vendor/runtime-linux-x64.tar.xz'));
  writeFileSync(join(root, 'scripts/vendor/runtime.sha256'), `${hash}  scripts/vendor/runtime-linux-x64.tar.xz\n`);
  console.log(JSON.stringify({ bytes, removed, minified, declarations, sha256: hash }));
} finally { rmSync(work, { recursive: true, force: true }); }
