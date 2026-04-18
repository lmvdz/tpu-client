# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## 2.0.0-alpha.7

### Changed
- **Package renamed**: `tpu-client` → `solana-tpu-client`. The previous name was ambiguous on npm search (TPU also refers to Google Tensor Processing Units) and didn't surface to Solana developers looking for a TPU submission library. The new name matches the Anza Rust crate naming convention (`solana-tpu-client`).
- All install snippets + import statements in README, MIGRATION, CHANGELOG, scripts, and tests updated accordingly.

### Migration
Nothing at runtime changed. If you were on `2.0.0-alpha.6`:
```diff
- "tpu-client": "2.0.0-alpha.6"
+ "solana-tpu-client": "2.0.0-alpha.7"
```
and:
```diff
- import { createTpuClient } from 'tpu-client';
+ import { createTpuClient } from 'solana-tpu-client';
```

The npm package name is the only surface change. The GitHub repo remains at `lmvdz/tpu-client` for now (renaming the GitHub repo is a separate step that affects existing PR/issue URLs; deferred pending need).

---

## 2.0.0-alpha.6

### Fixed — end-user-clean install
`npm install solana-tpu-client` now Just Works for unstaked and staked clients alike — no `patch-package` setup, no copied patch files, no manual steps.

### How
- Depends on a patched fork of `@matrixai/quic` pinned via a GitHub URL:
  ```
  "@matrixai/quic": "github:lmvdz/js-quic#release/tpu-fix"
  ```
  The branch contains `@matrixai/quic@2.0.9` with `dist/QUICStream.js` already patched to handle `initial_max_streams_uni: 0` peers. Version is renamed to `2.0.9-tpu-fix.0` so `npm ls` makes the fork's identity visible.
- An npm `overrides` entry forces every transitive resolution of `@matrixai/quic` to the fork too, preventing a downstream dep from pulling the buggy registry version.
- Native binaries (`@matrixai/quic-linux-x64`, `-darwin-arm64`, `-darwin-x64`, `-darwin-universal`, `-win32-x64`) continue to resolve from the npm registry normally via `optionalDependencies`. No Rust toolchain needed on the consumer side.
- Upstream PR: https://github.com/MatrixAI/js-quic/pull/157. When it merges + releases, we drop the override and return to the canonical package.

### Removed
- `patch-package` and `postinstall-postinstall` from devDeps.
- `postinstall: patch-package` from scripts.
- `patches/@matrixai+quic+2.0.9.patch` file + `patches` from `files[]`. The fix now lives in the fork's `dist/` directly.

### Verified (clean install from scratch)
- `rm -rf node_modules package-lock.json && npm install` — resolves `@matrixai/quic` from `git+ssh://git@github.com/lmvdz/js-quic.git#b538c57...`, version `2.0.9-tpu-fix.0`, patch markers present in `dist/QUICStream.js`.
- 83/83 unit tests pass.
- Integration test (`TPU_INTEGRATION=1 vitest run test/integration`) passes — transaction lands via TPU-QUIC on `solana-test-validator` at `processed` commitment.
- `npm audit`: 0 vulnerabilities.

---

## 2.0.0-alpha.5

### Fixed — THE BIG ONE (proof that the fix works)
- **TPU-QUIC send now lands transactions against Agave, end-to-end.** Pinpointed + fixed the `@matrixai/quic@2.0.9` eager-prime `StreamLimit` behavior that's incompatible with peers advertising `initial_max_streams_uni: 0` + post-handshake `MAX_STREAMS` credit — i.e. Agave's unstaked QoS. Verified:
  - **Local (`solana-test-validator` 3.1.11)**: integration test submits signed `SystemProgram::transfer` via TPU-QUIC and observes landing at `processed`. Was 0/N before; **now passes every run**.
  - **Live mainnet-beta**: 6-node probe. Pre-fix: 0/3 Agave sends succeeded. Post-fix: 2/3 Agave (1 unrelated network timeout), 3/3 Frankendancer. Includes probes against actively-leading Agave validators.
- **Upstream PR filed**: https://github.com/MatrixAI/js-quic/pull/157 — two small diffs to `QUICStream.ts`: (1) swallow eager-prime `StreamLimit` without leaking state; (2) bounded retry on `writableWrite` to absorb MAX_STREAMS arrival latency.

### How the fix ships to you (honest disclosure)
`patch-package` is a dev-loop tool: it patches OUR `node_modules` when WE run `npm install`, so our CI / integration tests / smoke scripts exercise the patched library. It does **NOT** automatically patch downstream consumers' installs — npm's security model intentionally forbids package A from modifying package B's files in package C's install tree.

For end users, the paths are:
1. **Staked identity** (recommended for prod anyway): Agave advertises nonzero initial stream credit to staked clients, so the bug doesn't trigger. This is the production path.
2. **Manual patch application**: the tarball ships `patches/@matrixai+quic+2.0.9.patch` (3 KB). Consumers can copy it into their project root's `patches/` and add `"postinstall": "patch-package"` + `"patch-package": "^8"` themselves. Same diff, applied to their tree.
3. **Wait for MatrixAI#157 to merge + release**: then this entire shim goes away and `npm install` Just Works.

### Added
- `patch-package` wired as devDependency; `postinstall: patch-package` runs at our install time.
- `patches/@matrixai+quic+2.0.9.patch` checked in and shipped in the tarball (`files[]` includes `patches`).
- Integration test now polls `getSignatureStatuses` after the TPU send and asserts landing within 20 s, retrying to absorb test-validator's unstaked-QoS drops.

### Changed
- Integration test uses `fanoutSlots: 1` against single-validator test harnesses so all 4 default fanout attempts don't stack onto the same loopback IP (which otherwise trips per-IP rate limiting).

---

## 2.0.0-alpha.4

### Known issues
- **Agave TPU-QUIC unstaked send path is blocked by upstream `@matrixai/quic` bug.** Agave advertises `initial_max_streams_uni: 0` for unstaked clients and issues `MAX_STREAMS` frames post-handshake. `@matrixai/quic@2.0.9` eager-primes every new stream via a zero-length `streamSend`, which fails with `StreamLimit` against Agave and corrupts internal stream-ID state on retry. **Send works against Frankendancer (~20% of mainnet leader slots) but fails against Agave (~80%) unless the client is staked.** The permanent fix is either (a) upstream patch to `@matrixai/quic` that retries `streamSend` on `StreamLimit` after waiting for `MAX_STREAMS`, or (b) switching to a different Node QUIC binding (e.g. a `quinn` NAPI wrapper). Tracked, not yet submitted upstream. Workaround for users: run with a staked identity keypair; staked clients get non-zero initial stream credit.

### Added
- `LICENSE` file (MIT) written to repo root — was only referenced in `package.json`, missing on disk.
- `@matrixai/logger` declared as peer + dev dependency (was imported in `src/quic-sender.ts` but undeclared — install-time failure for users).
- `CHANGELOG.md` added to `package.json` `files` so it ships in the tarball.
- `package.json` gains `keywords` and `sideEffects: false` for npm search + bundler tree-shaking.
- `package.json` `exports` map: `types` placed before `import` per current TS recommendation.
- `scripts/devnet-smoke.ts` — runnable E2E prover (`npm run smoke:devnet`) airdropping + self-transferring on devnet; manual tool, not CI.
- `scripts/firedancer-smoke.ts` now exercises `sendOnce` after handshake, revealing the Agave interop gap above.
- JSDoc on every public type: `CreateTpuClientOptions`, `TpuClient`, `TpuClientStats`, `SendResult`, `TpuConfirm*`, `LeaderAttempt`, all `TpuEvent` variants, all `TpuError` / `TpuLeaderError` / `TpuSendFailure` / `TpuRpcError` variants, `EventEmitter`, `noopEmitter`.
- Unit tests for the four alpha.3 additions: `ephemeral-identity`, `stale-snapshot`, `rpc-error`, `getStats()`.

### Fixed
- All 13 npm audit vulnerabilities (9 moderate, 4 high — all transitive from vitest 2.x) resolved by upgrading to vitest 4.x + `npm audit fix` for the rest. Zero outstanding.

## 2.0.0-alpha.3

### Breaking (within alpha)
- New TpuEvent variants: `stale-snapshot`, `ephemeral-identity` (replaces `console.warn`). Exhaustive switch consumers need `default:`.
- New TpuError kind: `rpc-error` (replaces misuse of `slot-subscription` by leader-cache).
- `AsyncSemaphore` gains an async `acquire()` method + wait queue (backward-compat: `tryAcquire` retained).

### Added
- `CreateTpuClientOptions.timeouts` for per-connection connect/write/destroy timeouts.
- `TpuClient.getStats()` returning `{ poolSize, inFlightSends, upcomingLeaders, quarantined, lastSnapshotAgeMs, lastSlotAgeMs, stakedKnown }`.
- Per-identity quarantine TTL (60s) rather than blanket clear on cluster-refresh.
- Input validation at `createTpuClient` (fanoutSlots 1..64, poolCap ≥1, maxStreamsPerConn ≥1).
- Default `poolCap` lowered from 1024 to 64 — closer to steady-state need.
- `LICENSE` file (MIT) on disk (was only referenced in `package.json`).
- Package keywords, proper description, sideEffects:false for tree-shaking.
- `noopEmitter` exported from barrel.

### Fixed
- 0-signature tx (tx[0] === 0) bypassed guards and reported a bogus signature. Now rejects with `{kind:'invalid-tx'}`.
- Malformed `tpuQuic` gossip entries no longer crash pool.acquire — `resolveTpuQuicAddr` returns null for unparseable addrs and the leader is skipped with `{kind:'no-tpu-addr'}`.
- `slotsInEpoch: 0n` defensive check — prevents divide-by-zero-like RPC-induced infinite loops.
- `stakedIdentities` refresh now validates bigint type and skips malformed entries.
- `attempts[]` in SendResult now in fanout-order (was completion-order, non-deterministic).
- slot-stall TpuEvent no longer spams (fires once per outage, not every 400ms).
- Pool `#drainAndClose` no longer busy-waits 25ms polling on refcount.
- Package.json `exports` map now has `types` before `import` (TS recommended order).
- README package-name references corrected throughout — install snippets and import examples now use the actual published name `tpu-client`.
- README Quickstart now notes it is a compilable skeleton; payer must be funded.
- README Reference `TpuIdentity` now lists `certPem` and `privateKeyPem`.

### Docs
- "Deployment checklist" and "Performance characteristics" sections.
- "Custom transport wrappers" example using `evaluatePinDecision`.
- Stale DESIGN.md / 00-overview.md updated to reflect alpha.2+.

---

## 2.0.0-alpha.2

### Breaking (within alpha)
- Split `TpuError` into `TpuLeaderError` + `TpuSendFailure` for better type narrowing. `TpuError` is kept as the backward-compat union.
- `LeaderAttempt` is now a discriminated union on `ok`: `{ok:true; rttMs}` | `{ok:false; error: TpuLeaderError}`.

### Fixed
- `close()` drain race where sends started after `closing=true` were lost (RT2-C1).
- `close()` hang when a send is stuck on QUIC backpressure — now accepts `timeoutMs` option (default 5 s).
- `TpuConfirmOptions.abortSignal` is now optional; defaults to a no-op signal when absent.
- Short tx bytes now throw `{kind:'invalid-tx', reason:'tx too short'}` instead of wrongly labeled `'all-failed'`.
- Transactions with >=128 signatures are now rejected explicitly with `{kind:'invalid-tx'}`.

### Added
- `invalid-tx` `TpuSendFailure` variant.
- `TpuLeaderError` and `TpuSendFailure` re-exported from the barrel for granular type narrowing.
- `evaluatePinDecision` re-exported from the barrel (useful for testing custom transport wrappers).
- `peerDependencies` for `@solana/kit`, `@matrixai/quic`, `@peculiar/x509` (was `dependencies`).
- CI Node 23 matrix entry + `npm pack --dry-run` verification step.
- Nightly CI job (`smoke-firedancer`) probing mainnet-beta to catch cert/ALPN changes.

---

## 2.0.0-alpha.1 (unreleased)

### Changed

- **Cert pinning is now `'observe'` by default** (was effectively `'strict'` in alpha.0). Empirical mainnet probing (April 2026, 6-node comparative sample) revealed that 100% of Frankendancer validators and a meaningful fraction of Agave validators present server certs whose SPKI does **not** equal the gossip-advertised identity pubkey — likely due to per-connection ephemeral certs or load-balancer TLS termination. Strict pinning silently broke ~20%+ of the leader schedule.
  - New option `CreateTpuClientOptions.pinMode: 'strict' | 'observe' | 'off'`, default `'observe'`.
  - `observe` accepts the connection on SPKI mismatch but still emits `cert-pin-mismatch` TpuEvent for telemetry.
  - `strict` preserves v2.0.0-alpha.0 behavior — safe for pure-Agave fleets that you know present identity-signed certs.
  - `off` skips the SPKI check entirely; client cert is still presented for QoS.
- Quarantine is now only populated by `strict`-mode mismatches (an `observe`-mode mismatch succeeded the handshake; quarantining it would lock the client out of legitimate leaders).
- New exported pure function `evaluatePinDecision` — unit-testable pin-decision logic without a live QUIC handshake.

## 2.0.0-alpha.0 (initial)

### Breaking

- **Rewritten on `@solana/kit` 3.x.** Drops `@solana/web3.js` v1 dependency entirely.
- **`TpuConnection` removed.** Use the `createTpuClient` factory instead.
- **ESM-only.** CommonJS `require()` is not supported.
- **Node ≥ 22.11 required.** Node 20 is approaching EOL (2026-04-30) and does not ship the WebCrypto Ed25519 API used by the identity module.
- **`sendRawTransaction` return type changed** from `string` to `{ signature: Signature; attempts: LeaderAttempt[] }`. All callers must be updated.
- **`sendTransaction(tx, signers)` removed.** Build signed wire bytes with `@solana/kit` and call `sendRawTransaction(bytes)`.
- **`sendAbortableTransaction` removed.** Pass `{ signal }` to `sendRawTransaction`.
- **`sendAndConfirmRawTransaction` removed.** Use `sendAndConfirmTpuTransactionFactory`.

### Added

- `createTpuClient(opts)` factory — async, returns after priming slot tracker and leader cache.
- `sendAndConfirmTpuTransactionFactory(cfg)` — kit-idiomatic send + confirm helper; races block-height expiry vs. signature status.
- **Staked QoS** via `opts.identity: CryptoKeyPair` — Ed25519 client cert presented in QUIC `ClientHello` for stake-weighted stream allocation.
- `ed25519KeyPairFromSolanaSecret(bytes)` — import a 64-byte `solana-keygen` JSON file into a `CryptoKeyPair`.
- `ed25519KeyPairFromSeed(seed)` — import a 32-byte Ed25519 seed into a `CryptoKeyPair`.
- **Server cert pubkey pinning** — leader Ed25519 pubkey extracted from peer X.509 cert and matched against gossip identity; mismatch quarantines the leader for the epoch.
- `onEvent: (e: TpuEvent) => void` observability hook with stable discriminated union.
- `TpuEvent` union: `ready`, `slot`, `slot-stall`, `leaders-refresh`, `cluster-refresh`, `conn-open`, `conn-close`, `conn-evict`, `cert-pin-mismatch`, `send`, `error`.
- `close()` — graceful drain of in-flight sends; idempotent.
- Epoch-boundary leader schedule union via `getLeaderSchedule(nextEpoch)` — fetched within 64 slots of boundary to avoid `getSlotLeaders` errors at epoch end.
- Slot stall watchdog — falls back to `getSlot` polling if no `slotNotification` for >2 s; recovers silently when WS resumes.
- Cold-start fallback — `getSlot` (400 ms TTL cache) populates initial slot while the WS estimator accumulates K=12 samples.
- `@matrixai/quic` ALPN set to `solana-tpu` — required by Firedancer; silently accepted by Agave.
- Per-connection stream semaphore (128 staked / 8 unstaked default) with fast-fail `BackpressureError`.
- LRU connection pool with cap 1024 and 30 s idle eviction.

### Fixed

- Uninitialized `last_epoch_info_slot` causing spurious first-tick leader refetches.
- Dead `last_cluster_refresh` timer that never updated — cluster node list was fetched once at startup and never refreshed.
- Fire-and-forget `sendRawTransaction` that returned before QUIC writes completed — callers could not observe send errors.
- Missing ALPN negotiation — Firedancer rejects QUIC connections without `solana-tpu`; previously sent without ALPN.
- Deprecated `onSlotUpdate` subscription replaced with `slotNotifications`.
- `tpuQuic` null gossip entries no longer panic — falls back to `tpu + 6` port heuristic, or emits `no-tpu-addr` attempt and skips the leader gracefully.

---

## 1.x (legacy)

The v1 `TpuConnection` branch is maintained at `1.x` with security-only fixes until 2026-10-30.
See [MIGRATION.md](./MIGRATION.md) for upgrade instructions.
