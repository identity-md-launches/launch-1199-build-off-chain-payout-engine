import { lstatSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const limit = 8 * 1024 * 1024;
const files = [];
function visit(path) {
  const name = relative(root, path);
  // These installed copies are rebuilt from the submitted archive. Scratch is never submitted.
  if (name === 'test/scratch' || name.split('/').includes('node_modules')) return;
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) visit(join(path, child));
  } else {
    if (!stat.isFile()) throw new Error(`Unexpected bundle symlink: ${name}`);
    files.push({ path: name, bytes: stat.size });
  }
}
for (const name of ['src', 'test', 'scripts', 'ecosystem.config.cjs', 'package.json', 'env.example', 'README.md', 'launch.example.json']) {
  visit(join(root, name));
}
const bytes = files.reduce((total, file) => total + file.bytes, 0);
console.log(JSON.stringify({ bytes, limit, remaining: limit - bytes, files: files.length }));
if (bytes > limit) {
  console.error('Source bundle exceeds 8 MiB:', files.sort((a, b) => b.bytes - a.bytes).slice(0, 5));
  process.exitCode = 1;
}
