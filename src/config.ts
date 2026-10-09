import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAddress, parseUnits, type Abi, type Address, type Hex } from 'viem';

export const IMD: Address = '0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127';
export const CHAIN_ID = 4663;
export const Q96 = 1n << 96n;
export const WAD = 10n ** 18n;
export const RULES = Object.freeze({ epochSeconds: 900, twapSeconds: 180, maxRoundNumerator: 1n,
  maxRoundDenominator: 3n, maxPayoutNumerator: 1n, maxPayoutDenominator: 1n, weightA: 1, weightB: 0 });
export type CallSpec = { functionName: string; args: unknown[] };
export type Launch = {
  chainId: 4663; token: Address; poolManager: Address; poolId: Hex; hook: Address;
  distributor: Address; router: Address; roundPayout: Address; payoutWallet: Address;
  deployer: Address; factory: Address; launchBlock: bigint; launchTs: number; launchTx: Hex;
  tokenDecimals: number; abis: { hook: Abi; roundPayout: Abi; distributor: Abi };
  distributorClaim: CallSpec; distributorPending: CallSpec;
  ethImdPool: { poolManager: Address; poolId: Hex; initializeBlock: bigint; ethCurrency: Address; ethDecimals: number };
};
export type Config = {
  launch: Launch; dataDir: string; executor: 'dry-run' | 'live';
  rules: typeof RULES & { minBuy: bigint; minPayout: bigint; maxRecipientsPerTx: number; excluded: Address[] };
  ops: { skimFraction: bigint; dexReserve: bigint; stallSeconds: number; heartbeatSeconds: number };
  exec: { maxRoundPayoutQuote: bigint; pauseFile: string; confirmations: number; timeoutMs: number };
  rpc: { urls: string[]; logsUrl: string; priorityUrl: string; pollMs: number; anchorSpacing: bigint;
    followMargin: bigint; logChunk: bigint; backoffMs: number; timeoutMs: number };
  api: { host: string; port: number }; prices: { intervalMs: number; coinGeckoUrl: string; dexScreenerUrl?: string };
};
export function address(value: unknown, name = 'address', allowNative = false): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) ||
      (!allowNative && /^0x0{40}$/i.test(value))) throw new Error(`Invalid ${name}; supply a deployed address`);
  return value.toLowerCase() as Address;
}
export function hash(value: unknown, name = 'hash'): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value.toLowerCase() as Hex;
}
function uint(value: unknown, name: string): bigint {
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`Invalid ${name}`);
  return BigInt(String(value));
}
function integer(value: unknown, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
function abi(value: unknown, name: string, names: string[]): Abi {
  if (!Array.isArray(value) || !names.every(n => value.some(x => x && x.name === n))) throw new Error(`Missing ${name} ABI members: ${names.join(', ')}`);
  return value as Abi;
}
function call(value: any, name: string): CallSpec {
  if (!value || typeof value.functionName !== 'string' || !Array.isArray(value.args)) throw new Error(`Missing ${name} call and arguments`);
  return value;
}
export function validateLaunch(input: any): Launch {
  if (input?.chainId !== CHAIN_ID) throw new Error('launch.chainId must be 4663');
  const out = { ...input } as Launch;
  for (const key of ['token','poolManager','hook','distributor','router','roundPayout','payoutWallet','deployer','factory'] as const)
    out[key] = address(input[key], key);
  out.poolId = hash(input.poolId, 'poolId'); out.launchTx = hash(input.launchTx, 'launchTx');
  out.launchBlock = uint(input.launchBlock, 'launchBlock');
  out.launchTs = integer(input.launchTs, 'launchTs', 1, Number.MAX_SAFE_INTEGER - 900);
  out.tokenDecimals = integer(input.tokenDecimals, 'tokenDecimals', 0, 36);
  out.abis = {
    hook: abi(input.abis?.hook, 'hook', ['sweep','pending','FeeAccrued','Swept']),
    roundPayout: abi(input.abis?.roundPayout, 'roundPayout', ['fund','payRound','retryFailed','writeOffFailed','isPaid','rounds','failed','paused','owner','Funded','Paid','PayFailed','WrittenOff','RoundPaid']),
    distributor: abi(input.abis?.distributor, 'distributor', [input.distributorClaim?.functionName, input.distributorPending?.functionName]),
  };
  const requireFields=(abi:Abi,event:string,fields:string[])=>{
    const item=abi.find((e:any)=>e.type==='event'&&e.name===event) as any;
    if(!item||!fields.every(name=>item.inputs?.some((i:any)=>i.name===name)))throw new Error(`ABI ${event} parameter names do not match the engine schema`);
  };
  requireFields(out.abis.hook,'FeeAccrued',['isSell','baseFeeImd','surchargeImd','imdLeg']);
  requireFields(out.abis.hook,'Swept',['imdAmount','to']);
  requireFields(out.abis.roundPayout,'Funded',['token','amount']);
  for(const event of ['Paid','PayFailed'])requireFields(out.abis.roundPayout,event,['roundId','to','amount']);
  requireFields(out.abis.roundPayout,'WrittenOff',['roundId','to']);
  requireFields(out.abis.roundPayout,'RoundPaid',['roundId','ledgerHash','twapCloseX96','totalEligibleLoss']);
  out.distributorClaim = call(input.distributorClaim, 'distributorClaim');
  out.distributorPending = call(input.distributorPending, 'distributorPending');
  const p = input.ethImdPool;
  if (!p) throw new Error('Missing ethImdPool');
  out.ethImdPool = { poolManager: address(p.poolManager), poolId: hash(p.poolId), initializeBlock: uint(p.initializeBlock,'ethImdPool.initializeBlock'),
    ethCurrency: address(p.ethCurrency,'ethImdPool.ethCurrency',true), ethDecimals: integer(p.ethDecimals,'ethDecimals',0,36) };
  if (out.token === IMD.toLowerCase()) throw new Error('MONEYBACK cannot be IMD');
  return out;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env, launchInput?: unknown): Config {
  const launch = validateLaunch(launchInput ?? JSON.parse(readFileSync(resolve(env.LAUNCH_FILE || 'launch.json'), 'utf8')));
  const num = (key: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => integer(env[key] ?? fallback, key, min, max);
  const quote = (key: string, fallback: string) => {
    const raw = env[key] || fallback;
    if (!/^\d+(\.\d{1,18})?$/.test(raw)) throw new Error(`Invalid ${key}`);
    return parseUnits(raw,18);
  };
  const url = (s: string) => { const u = new URL(s); if (!['http:','https:'].includes(u.protocol)) throw new Error('RPC requires HTTP(S)'); return s; };
  const urls = (env.RPC_URLS || '').split(',').map(x=>x.trim()).filter(Boolean).map(url);
  if (!urls.length || !env.RPC_PRIORITY_URL) throw new Error('RPC_URLS and RPC_PRIORITY_URL are required');
  const executor = env.EXECUTOR || 'dry-run';
  if (executor !== 'dry-run' && executor !== 'live') throw new Error('EXECUTOR must be dry-run or live');
  const dataDir = resolve(env.DATA_DIR || 'data');
  const skimFraction = quote('OPS_SKIM_FRACTION','0');
  if (skimFraction > WAD) throw new Error('OPS_SKIM_FRACTION must be between 0 and 1');
  return { launch, dataDir, executor,
    rules: { ...RULES, minBuy: quote('MIN_BUY_QUOTE','0'), minPayout: quote('MIN_PAYOUT_QUOTE','0'),
      maxRecipientsPerTx: num('MAX_RECIPIENTS_PER_TX',200,1,1000), excluded: (env.EXCLUDED_ADDRESSES || '').split(',').filter(Boolean).map(x=>address(x.trim())) },
    ops: { skimFraction, dexReserve: quote('DEX_RESERVE_QUOTE','0'), stallSeconds: num('STALL_SECONDS',300), heartbeatSeconds: num('HEARTBEAT_SECONDS',3600) },
    exec: { maxRoundPayoutQuote: quote('MAX_ROUND_PAYOUT_QUOTE','100000'), pauseFile: resolve(env.PAUSE_FILE || `${dataDir}/PAUSE`), confirmations: num('CONFIRMATION_BLOCKS',5), timeoutMs: num('TX_TIMEOUT_MS',120000) },
    rpc: { urls, logsUrl: url(env.RPC_LOGS_URL || urls[0]), priorityUrl: url(env.RPC_PRIORITY_URL), pollMs: num('VIEM_POLL_MS',750),
      anchorSpacing: BigInt(num('ANCHOR_SPACING',100)), followMargin: BigInt(num('FOLLOW_MARGIN',20)), logChunk: BigInt(num('LOG_CHUNK_BLOCKS',10000)), backoffMs: num('RPC_BACKOFF_MS',1000), timeoutMs: num('RPC_TIMEOUT_MS',15000) },
    api: { host: env.API_HOST || '127.0.0.1', port: num('API_PORT',8787,1,65535) },
    prices: { intervalMs: 60000, coinGeckoUrl: env.COINGECKO_ETH_URL || 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', dexScreenerUrl: env.DEXSCREENER_ETH_URL || undefined },
  };
}
export function exclusions(c: Config): Set<string> {
  return new Set([c.launch.token, IMD, c.launch.deployer,c.launch.factory,c.launch.distributor,c.launch.poolManager,
    c.launch.hook,c.launch.router,c.launch.roundPayout,c.launch.payoutWallet,
    '0x000000000000000000000000000000000000dead','0x0000000000000000000000000000000000000000',...c.rules.excluded].map(x=>x.toLowerCase()));
}
