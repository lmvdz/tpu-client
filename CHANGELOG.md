# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## 2.0.0-alpha.0 (unreleased)

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
