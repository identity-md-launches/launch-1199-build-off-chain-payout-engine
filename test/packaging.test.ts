import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, formatMessages, transform } from 'esbuild';

const require = createRequire(import.meta.url);
describe('offline distribution', () => {
  it('ships the complete source export within the upload limit', () => {
    const result = JSON.parse(execFileSync(process.execPath, ['scripts/check-bundle.mjs'], { encoding: 'utf8' }));
    expect(result.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.files).toBeGreaterThan(40);
  });
  it('pins the archive checksum and the shared esbuild WASM implementation', () => {
    const bytes = readFileSync('scripts/vendor/runtime-linux-x64.tar.xz');
    const expected = readFileSync('scripts/vendor/runtime.sha256', 'utf8').trim().split(/\s+/)[0];
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    expect(require('esbuild/package.json')).toMatchObject({ name: 'esbuild-wasm', version: '0.27.4' });
    expect(require('tsx/package.json').version).toBe('4.21.0');
  });
  it('retains Node named exports and the PM2 process-monitoring implementation', async () => {
    expect(typeof build).toBe('function');
    expect(typeof formatMessages).toBe('function');
    const code = await transform('export const amount: bigint = 12n;', { loader: 'ts' });
    expect(code.code).toContain('12n');
    // A real runtime module named history.js must not be mistaken for documentation.
    expect(typeof require('pidusage/lib/history').get).toBe('function');
  });
});
