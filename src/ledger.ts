import { mkdirSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { keccak256, toBytes, type Hex } from 'viem';

/** Canonical JSON: sorted object keys, preserved array order, decimal bigint strings; no whitespace/newline. */
export function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    if (s === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Non-JSON ledger value');
    return s;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`;
}
export const ledgerHash = (value: unknown): Hex => keccak256(toBytes(canonical(value)));
export function atomicWrite(file: string, bytes: string, mode = 0o600): void {
  mkdirSync(dirname(file), {recursive:true,mode:0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp,file);
  const dir = openSync(dirname(file),'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
const encode = (_: string, v: unknown) => typeof v === 'bigint' ? { $bigint: v.toString() } : v;
const decode = (_: string, v: any) => v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v;
export class Store {
  constructor(readonly root: string) {}
  path(name: string): string {
    const file = resolve(this.root,name);
    if (!file.startsWith(`${resolve(this.root)}/`)) throw new Error('Invalid store path');
    return file;
  }
  read<T>(name: string, fallback: T): T {
    const file = this.path(name); if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file,'utf8'),decode) as T;
  }
  write(name: string, value: unknown): void { atomicWrite(this.path(name),JSON.stringify(value,encode)); }
  publish(name: string, value: unknown): void { atomicWrite(this.path(name),canonical(value),0o644); }
  immutable(name: string, value: unknown): void {
    const file = this.path(name), bytes = canonical(value);
    if (existsSync(file)) { if (readFileSync(file,'utf8') !== bytes) throw new Error('Immutable ledger mismatch'); return; }
    atomicWrite(file,bytes,0o644);
  }
}
