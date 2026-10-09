import { Q96, RULES } from './config.js';
export type Observation = { timestamp: number; priceX96: bigint; blockNumber: bigint; logIndex: number };
export function priceX96(sqrtPriceX96: bigint, imdIsCurrency1: boolean): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error('Invalid sqrt price');
  const square = sqrtPriceX96 * sqrtPriceX96;
  return imdIsCurrency1 ? square / Q96 : Q96 * Q96 * Q96 / square;
}
export function ordered(observations: readonly Observation[]): Observation[] {
  return [...observations].sort((a,b)=>a.timestamp-b.timestamp || (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex-b.logIndex));
}
/** Arithmetic IMD/token TWAP on [close-window, close). A boundary swap belongs to the next epoch. */
export function twap(observations: readonly Observation[], close: number, window: number = RULES.twapSeconds): bigint {
  if (!Number.isSafeInteger(close) || !Number.isSafeInteger(window) || window <= 0) throw new Error('Invalid TWAP window');
  const start = close-window, obs = ordered(observations);
  let price: bigint | undefined, cursor = start, weighted = 0n;
  for (const o of obs) {
    if (o.priceX96 <= 0n) throw new Error('Invalid observation');
    if (o.timestamp <= start) { price = o.priceX96; continue; }
    if (o.timestamp >= close) break;
    if (price === undefined) throw new Error('No price at TWAP window start');
    weighted += price * BigInt(o.timestamp-cursor); cursor = o.timestamp; price = o.priceX96;
  }
  if (price === undefined) throw new Error('No price history');
  return (weighted + price * BigInt(close-cursor))/BigInt(window);
}
export function epochIndex(launchTs: number, timestamp: number): number {
  return Math.max(0,Math.floor((timestamp-launchTs)/RULES.epochSeconds));
}
export const epochClose = (launchTs: number, epoch: number) => {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Epochs start at 1');
  return launchTs + epoch * RULES.epochSeconds;
};
