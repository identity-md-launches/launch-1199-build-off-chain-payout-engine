# IMD Money Back payout engine

A TypeScript + tsx + viem service for Robinhood Chain **4663**. It indexes MONEYBACK transfers and its v4 pool, computes an IMD loss ledger on the launch-relative 900-second grid, and optionally pays through the deployed RoundPayout. There is no frontend and no contract deployment step.

**Default mode is `EXECUTOR=dry-run`.** A live signer is never constructed in that mode. USD prices are display data only; every eligibility decision, allocation, funding amount and payment uses integer IMD units.

This checkout contains no actual launch.json, token address, distributor claim proof or deployed ABIs. `launch.example.json` deliberately contains invalid, explicit placeholders. Supply the real launch metadata before a live-chain backfill or live execution. The included synthetic fixtures are tests, never deployment defaults. Live-pool backfill could not be verified without those inputs.

## Install and verify (offline)

Use Linux x86-64, Node.js 22.12 or newer, GNU tar, `xz` from xz-utils, and `flock` from util-linux. Foundry needs Solidity 0.8.26 for the independent accounting specification tests.

```sh
node scripts/install.mjs
npm run typecheck
npm test
npm run replay -- --fixture test/fixtures/replay.json --expected test/fixtures/ledgers
npm run check:bundle
forge build
forge test
```

The required Node runtime, including tsx, viem, Vitest, the TypeScript compiler and pm2, is pinned in `scripts/vendor/dependencies.lock.json` and shipped in `scripts/vendor/runtime-linux-x64.tar.xz`. Installation checks its SHA-256, extracts into a temporary directory, then replaces `src/node_modules`; `test/node_modules` and `scripts/node_modules` link to that local tree. No registry, git submodule, global npm installation or network is needed. `npm test` also installs this runtime automatically if absent. Keep the archive and checksum together. The archive includes dependency licenses. To target another OS/architecture, build and vendor a matching archive before deployment.

The export stays below 8 MiB by sharing esbuild-wasm 0.27.4 between tsx 4.21.0 and Vitest, using XZ compression, minifying dependency JavaScript with function names retained, and removing declaration comments. Node's esbuild export annotations are preserved. The service source and replay fixtures are unchanged by packaging. The archive omits dependency development tests, documentation, source maps, duplicate TypeScript sources, translated compiler diagnostics, TypeScript editor/server tools, the PM2 browser bundle, and KZG blob setup files. The compiler CLI, Node runtime APIs and assets used by this engine remain included; blob transactions and editor tooling are outside this service. Run `npm run check:bundle` before submitting; installed node_modules and `test/scratch` are generated copies, not export inputs.

To reproduce the archive as a maintainer (registry access is needed only for this rebuild), create a fresh directory under `test/scratch`, copy `scripts/vendor/dependencies.lock.json` into it as `package-lock.json`, and create a `package.json` with that lockfile's root `dependencies` plus `"overrides":{"esbuild":"npm:esbuild-wasm@0.27.4"}`. Run `npm ci --ignore-scripts --no-audit --no-fund` there, then `node scripts/pack-runtime.mjs PATH_TO_THAT_DIRECTORY`. This applies the documented reductions, normalizes tar metadata, and updates the archive and checksum. Reinstall from the resulting archive and run all the checks above before using it. Do not include npm caches or expanded dependencies in the export.

Vitest runs the actual TypeScript modules, mocked chain and raw-log fixture replay. Tests never use an RPC or external network, and scratch files go under `test/scratch/`. `forge test` separately compiles and runs an independent Solidity specification of the locked accounting rules, including fuzzed cap and conservation properties. Foundry does not execute TypeScript; run both suites.

## Configure the launch

Copy `launch.example.json` to an operator-managed `launch.json` and replace every placeholder. Use deployment records and verified contract ABIs, not token symbols or guessed addresses. IMD is the only deployment address compiled into the engine. PoolManager and all launch addresses come from launch.json. The configured MONEYBACK pool is checked against its Initialize event, both currency addresses, its hook, and the fixed 12,500 ppm LP fee. Currency ordering is never assumed. `tokenDecimals` must match `decimals()` on-chain.

`launchBlock` must include **all** MONEYBACK transfers, including initial mint and liquidity funding. `launchTs` is the fixed epoch origin. The engine stops on an incomplete negative balance history. `launchTx` identifies the launch transaction.

The supplied JSON ABIs must expose the specified functions and these decoded parameter names:

| Contract | Required decoded events / views |
| --- | --- |
| Hook | `FeeAccrued(isSell, baseFeeImd, surchargeImd, imdLeg)`, `Swept(imdAmount, to)`, `sweep()`, `pending()` returning one uint256 |
| RoundPayout | `owner`, `paused`, `isPaid(roundId)`, `rounds`, `failed(roundId,to)` returning uint256; `fund`, `payRound`, `retryFailed`, `writeOffFailed` |
| RoundPayout events | `Funded(token,amount)` (extra fields allowed), `Paid(roundId,to,amount)`, `PayFailed(roundId,to,amount)`, `WrittenOff(roundId,to)`, `RoundPaid(roundId,ledgerHash,twapCloseX96,totalEligibleLoss)` (extra fields allowed) |
| Distributor | The exact pending and permissionless claim functions described by `distributorPending` and `distributorClaim` |

Preserve **actual indexed flags** in the ABI. ABI argument names above are the engine's normalization contract; use the verified deployment ABI or an equivalent ABI with matching names. Claim `args` are JSON ABI arguments; encode uint256 values as decimal strings to avoid JavaScript precision loss. Provide the real payout-wallet Merkle proof where needed. A distributor whose proof/root changes requires updating its configured claim arguments and restarting between drops. Never use a guessed empty proof.

`ethImdPool` identifies the public RH ETH/IMD **v4** pool and its exact Initialize block. Its ETH currency can be the native-currency sentinel if the actual pool uses native ETH, or its verified wrapped ETH address. The snapshot service derives ordering from that pool's Initialize log too. This pool is solely a display-price source.

Discovery can locate the pool and probe launch metadata getters:

```sh
npm run discover -- --token "$MONEYBACK_ADDRESS" \
  --pool-manager "$POOL_MANAGER_ADDRESS" --rpc "$RPC_PRIORITY_URL" \
  --from-block "$SEARCH_START_BLOCK" --to-block "$SEARCH_END_BLOCK"
```

Use a bounded deployment search range. If several pools match, add `--pool-id`. Discovery prints Initialize currencies, pool id, hook, launch block/time/tx and token decimals. Add `--factory-abi path/to/verified-factory-abi.json` to decode launch receipt fields directly. Discovery also searches the bounded range for initial token mints and probes token-indexed distributor getters. It probes `factory()`, `distributor()`, `router()`, `roundPayout()` and `payoutWallet()` on token/hook/launch target. Metadata not exposed by those getters remains an explicit placeholder: recover it from the launch transaction and factory ABI. Verify the first token-mint block before using the suggested launchBlock. Discovery never guesses missing addresses or signs anything.

## Dry-run backfill

Copy `env.example` to a local nonsecret environment file. Set the real RPC URLs and load the environment. An archive-capable priority endpoint is required for historical `getCode`, headers and funding-balance proofs. All RPC endpoints must report chain ID 4663. The indexing frontier is the lowest endpoint head minus FOLLOW_MARGIN; an unavailable endpoint stops frontier advancement.

```sh
set -a
. ./.env
set +a
export EXECUTOR=dry-run
export DATA_DIR=data-dry
npm run rounds -- --once
npm run snapshot -- --once
npm run data
```

`--once` backfills, computes completed historical epochs, writes immutable ledgers, then prints a `next-epoch-preview` with payees and amounts using the latest close and **realized** pouch receipts. Unclaimed hook/distributor balances are not invented as historical receipts. A pool with no realized receipts has a zero pot in dry-run. Market prices and receipts can change before the next boundary.

Inspect `data-dry/status.json`, `treasury.json`, `wallets.json` and `ledgers/*.json`. Investigate excluded wallets, empty pots, incomplete transfer history or mismatched Initialize metadata before enabling a signer. Never reuse simulated payments as live accounting: live and dry-run require separate data directories, enforced on restart.

## Run under pm2 and go live

Set the nonsecret settings for the intended mode and data directory. Keep backups of the complete live data directory, especially `private/`. The kernel writer lock prevents concurrent rounds or maintenance processes from modifying that state. Only one rounds instance is supported.

For live mode, the configured payout wallet must own RoundPayout and have ETH for gas. It receives the hook and distributor IMD. Inject its key through the environment, without putting it in shell history or a file:

```sh
export EXECUTOR=live
export DATA_DIR=data-live
read -rsp 'Payout private key: ' PAYOUT_PRIVATE_KEY
export PAYOUT_PRIVATE_KEY
printf '\n'
npm run pm2 -- start ecosystem.config.cjs
unset PAYOUT_PRIVATE_KEY
```

The three required applications are `rounds` (executor + in-process indexer), `snapshot` and `data`. The latter two filter the payout key from their environment. The API binds to 127.0.0.1:8787 by default. Use a reverse proxy to expose only the public API/data endpoints; do not expose the state directory itself.

Always use the provided `npm run pm2 -- ...` launcher. It forces both pm2 dump destinations to `/dev/null`, including the automatic dump on daemon signal exit, disables commands that print environment diagnostics, and refuses an existing daemon without that protection. Its dedicated home defaults to DATA_DIR/private/pm2. Do **not** bypass the launcher, use environment diagnostic dumps, enable shell tracing, or put a key in ecosystem configuration. Use an operator-managed boot process that reinjects the key from the environment/secret manager. The engine never logs or persists a private key; it does persist signed transaction bytes for safe recovery, so keep `data-live/private` private. Do not change a running daemon's signer or nonce state manually.

On a fresh live start or after downtime, the engine executes the latest completed grid epoch and records earlier missed epochs in `status.skipped`; it does not manufacture retroactive live drops using stale market losses. Historical dry-run replay still computes every epoch. Every actual drop keeps its original epoch index and exact claim cutoff block for replay.

## Accounting and ledgers

Amounts are integer token atomic units. IMD has 18 decimals. `entry`, `close`, `closeX96`, and `twapCloseX96` are **IMD wei per MONEYBACK atomic unit, multiplied by 2^96**, not square-root prices. For human IMD per MONEYBACK, divide by 2^96 and multiply by 10^(tokenDecimals − 18). Swap sqrt prices are squared/inverted according to Initialize ordering before averaging.

TWAP is an arithmetic time-weighted price over `[boundary−180, boundary)`. The latest chain log wins within a timestamp. No-swap windows carry the last price; Initialize seeds the initial observation. There is no future-price backfill into missing history. Anchor headers are approximately 100 blocks apart; event blocks in intervals touching an epoch or TWAP boundary use exact timestamps.

A qualifying transaction must have a positive wallet balance change, output from this pool and this hook's fee-paid buy event. v4 core Swap input includes LP fees; separately accrued hook fees are added once. The IMD leg is the basis even when a router bought IMD using ETH. MONEYBACK output provenance follows PoolManager/router transfer flows and is apportioned to delivered tokens. Other pools, OTC transfers, airdrops and unrelated same-transaction inflows add no basis. Any positive transfer out to another address voids that sender permanently, even when a buy in the same transaction makes its net balance rise. Self transfers and zero transfers are not decreases. System addresses and any observed code, including delegated-account code, are excluded.

For an eligible wallet:

```text
entry = floor(total qualifying IMD cost * 2^96 / qualifying tokens)
loss = floor(max(entry - close, 0) * qualifying tokens / 2^96)
cap = min(floor(loss / 3), max(loss - paid - reservedFailed, 0))
share = floor(pot * loss / sum(loss of eligible wallets with positive cap))
amount = min(share, cap); skip if amount < minPayout or amount == 0
```

Capped excess, skipped small legs and integer dust roll forward. A fully covered wallet receives nothing until a larger loss appears. Failed legs are reserved against both treasury funds and future wallet coverage; only actual `Paid` events increase actual cumulative payments.

`bookClaim` deduplicates chain event IDs. It adds hook Swept amounts backed by IMD Transfers from the hook/PoolManager, and one quarter of direct distributor receipts. The remaining distributor amount, including indivisible dust, belongs to team. Top-ups and other inflows never enter the pot. OPS_SKIM_FRACTION applies once to each new pouch receipt; reserve fills once from the remainder. Neither rolled funds nor team funds are skimmed. `treasury.json` shows pouch, team, ops and DEX reserve independently. The engine does not send ops/team/reserve distributions.

Each `ledgers/EPOCH.json` contains version, epoch index, close time/price, eligible loss, pot, sorted payees (`payee`, `loss`, `entry`, `close`, `amount`), and leftover. Canonical bytes use lexicographically sorted object keys, decimal-string integers, preserved payee order, no whitespace and **no trailing newline**. The ledger hash is Ethereum keccak256 of those exact UTF-8 bytes. Every chunk uses the same hash and totalEligibleLoss; `roundId = epochIndex*1000 + chunkIndex`, with zero-based chunkIndex. More than 1,000 chunks is refused to prevent ID overlap.

## Funding, pause and recovery

For each live drop: sweep -> trigger distributor claim -> wait for receipts to enter the safe indexed frontier -> book claims -> compute and persist the immutable ledger -> approve/fund -> pay chunks. Each transaction has a durable operation ID, nonce, signed intent and hash persisted before broadcast. A timeout or crash resumes that same transaction. Unknown outcomes are pending, never inferred failures.

Funding requires a confirmed successful receipt containing both matching RoundPayout `Funded` and IMD `Transfer(payoutWallet, RoundPayout, amount)` logs, followed by an archive priority-node balance read at the funding block. Current priority-node balance is checked again before payment. A lagging zero balance stalls without marking the round failed or funding twice. Existing top-ups to RoundPayout do not become spendable accounting credit. Proved funding/write-offs create credits; executed chunk totals debit them. Exact approvals are used, with a zero-reset when needed.

`isPaid` is re-read for every chunk and immediately before send. Already-paid chunks must match the prepared ledger hash and every leg. Newly observed code, outflows or missing qualifying balances stop an unsent payment. A prepared round that ages into the following epoch also stops; investigate it before releasing a new plan. A trade can occur after a preflight read and before transaction inclusion; the deployed RoundPayout has no on-chain eligibility gate, so this off-chain race cannot be eliminated by the service.

Create the configured pause file to halt **all new broadcasts**, including sweep, approve, fund, pay, retry and write-off:

```sh
touch "$DATA_DIR/PAUSE"    # or your explicit PAUSE_FILE
npm run pm2 -- logs rounds
# Remove the pause file only when ready to resume.
```

A transaction already broadcast can still mine. Contract `paused()` also prevents executor funding/payment/maintenance. On RPC outages, uncertain receipts, proof failures or a reorg, retain journals and fix the cause; do not delete state or substitute another nonce. A detected indexed reorg requires pausing, restoring a consistent checkpoint and reconciling actual RoundPaid events before resumption. The default five confirmations/follow margin are operational finality, not Ethereum settlement finality.

To reconcile a permissionless, out-of-band sweep, stop the writer and record its confirmed transaction (no manually supplied amount is accepted):

```sh
npm run pm2 -- stop rounds
npm run reconcile -- --tx "$SWEEP_TX_HASH"
```

The script validates/indexes its real sweep receipt and records event IDs; the next drop books them at most once. To retry or write off failed legs, stop rounds, supply the live key environment again, and use:

```sh
node scripts/run.mjs tsx scripts/manage-failed.ts retry "$ROUND_ID" "$ATTEMPT_NUMBER" "$RECIPIENT"
node scripts/run.mjs tsx scripts/manage-failed.ts write-off "$ROUND_ID" "$RECIPIENT"
```

Retries include only addresses whose `failed` view remains nonzero. Maintenance first catches up the index and rechecks current eligibility and loss caps, excluding the leg being retried from its own reservation. A recovered price or a disqualifying outflow blocks retry; retain or explicitly write off that reservation. Use a new positive attempt number for each new retry batch; reuse an attempt only to recover the same operation. A write-off requires a WrittenOff receipt and zero failed balance, then releases the reserved amount as known contract funding credit. Its indexed event also returns that reservation to the pouch once, without another skim or DEX reserve charge. It is an explicit operator decision. Resume the same live state after maintenance.

If a prepared round becomes stale or its unsent recipients lose eligibility, stop rounds and run `node scripts/run.mjs tsx scripts/abandon-round.ts`. This performs no broadcasts and needs no private key. It refuses while any signed epoch transaction is unresolved, verifies every executed chunk and funding receipt, preserves the original ledger, and releases only unsent allocations back to the pouch. A durable abandonment marker makes this maintenance operation restartable. The daemon continues at the next grid epoch; replay accounts for partial/abandoned drops. Never remove a signed intent to force abandonment.

MAX_ROUND_PAYOUT_QUOTE defaults to 100,000 IMD. Set an operationally appropriate cap before live use. A larger computed round is refused and alerted; the engine never truncates a ledger to hide an absurd amount.

## API, snapshots and alerts

- `GET /api/status`: status snapshot and `prices {imdUsd, ethUsd, tokenUsd, source, at}`.
- `GET /api/wallet/:address`: the same eligibility/cap/allocation code as the engine, plus paid, reserved, entry, loss, next-drop estimate and indexed block.
- `GET /data/*`: an explicit allowlist of public JSON files and immutable epoch ledgers. Private journals, arbitrary paths and symlink escapes are rejected.

Snapshots include token, status, treasury, rounds, chart, leaderboard, wallets and ledgers. Prices refresh every 60 seconds from RH ETH/IMD spot and CoinGecko ETH/USD, with optional Dexscreener ETH/USD fallback. A failure retains the complete last good price object and its original `at` timestamp; initial unknown prices are null. USD never changes the payment calculation. Estimates use the last completed close and currently realized pot, not a promise of future prices.

Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for paid, failed, refused, stalled and heartbeat messages. Without them, the same sanitized summaries go to stdout. No raw RPC exceptions, account objects, keys or environment dumps are sent. STALL_SECONDS and HEARTBEAT_SECONDS control monitoring. Monitor disk capacity, chain progress, pending transactions, reserved failed legs and stale price timestamps.

## Verify a drop on-chain

1. Read its immutable ledger, compute `keccak256(UTF8(file bytes))`, and compare it with every chunk's RoundPaid ledgerHash. Do not reformat the file before hashing.
2. Compute round IDs from the epoch and chunk index. On the priority node, check `isPaid`, `rounds`, and the corresponding RoundPaid receipt; confirm token=IMD, recipients, amounts, close and total eligible loss.
3. Check each leg's Paid or PayFailed event and current `failed(roundId,to)`. A successful payRound transaction does not imply every recipient was paid.
4. Trace the funding receipt's Funded and IMD Transfer logs and its historical RoundPayout IMD balance. Compare team/ops/reserve accounting with independently indexed receipt IDs.
5. Recompute from cached chain logs and compare canonical ledgers and on-chain events:

```sh
npm run replay -- --expected "$DATA_DIR/ledgers" --out "$DATA_DIR/replay"
```

Replay's fixture mode is entirely offline; live mode reads RoundPaid logs and reports differing or missing rounds, hashes and oracle fields. Recorded live claim cutoffs are used to assign post-boundary sweep/claim receipts to their actual drop. Keep the complete data directory to preserve those cutoffs and any failed-leg history.
