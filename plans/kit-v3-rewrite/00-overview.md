# Overview — kit-v3-rewrite

Branch: `rewrite/kit-v3` (already created).

Full rewrite per [DESIGN.md](DESIGN.md). 15 concerns. Batched for parallel execution with 1 inline opus review per batch.

## Scope

| # | Concern | Complexity | Touches |
|---|---|---|---|
| 01 | Scaffold: package.json, tsconfig, delete old src, create dirs | mechanical | package.json, tsconfig.json, src/, test/, .gitignore |
| 02 | errors.ts + events.ts (shared public types) | mechanical | src/errors.ts, src/events.ts |
| 03 | addr.ts (URL-based host:port parse + tpu+6 fallback) | mechanical | src/addr.ts |
| 04 | Research: verify @matrixai/quic verifyCallback signature + test vector for Solana server cert SPKI parse + Firedancer ALPN/cert spot-check | research | (no files — writes research notes to plans/kit-v3-rewrite/NOTES-07.md) |
| 05 | route-snapshot.ts (immutable frozen snapshot + atomic ref) | mechanical | src/route-snapshot.ts |
| 06 | identity.ts (Ed25519 keypair + X.509 mint via @peculiar/x509) | architectural | src/identity.ts |
| 07 | slot-tracker.ts (WS sub + estimator + cold/stall fallback + ready promise) | architectural | src/slot-tracker.ts |
| 08 | leader-cache.ts (LeaderDiscoveryProvider + epoch union + refresh loop) | architectural | src/leader-cache.ts |
| 09 | quic-pool.ts (per-identity pool, LRU, refcount, semaphore, eviction) | architectural | src/quic-pool.ts |
| 10 | quic-sender.ts (@matrixai/quic wrap, verifyCallback pin, ALPN, stream send) | architectural | src/quic-sender.ts |
| 11 | tpu-client.ts (createTpuClient orchestration, AsyncDisposableStack init, close) | architectural | src/tpu-client.ts |
| 12 | confirm.ts (sendAndConfirmTpuTransactionFactory — mirrors kit's state machine) | architectural | src/confirm.ts |
| 13 | index.ts barrel (public exports only) | mechanical | src/index.ts |
| 14 | Unit tests (addr, route-snapshot, slot-tracker, leader-cache epoch boundary) | architectural | test/unit/*.test.ts |
| 15 | Integration test + README/MIGRATION.md | architectural | test/integration/validator.test.ts, README.md, MIGRATION.md, CHANGELOG.md |

## Dependency graph

```
01 scaffold (no deps)
 ├── 02 errors+events ── (blocks: 07, 08, 09, 10, 11, 12)
 ├── 03 addr ──────────── (blocks: 08, 10)
 ├── 04 research ──────── (blocks: 10)
 └── 05 route-snapshot ── (blocks: 08, 11)
 └── 06 identity ──────── (blocks: 10, 11)

02 + 03 + 04 + 05 + 06 done →
 ├── 07 slot-tracker ──── (blocks: 11)
 ├── 08 leader-cache ──── (blocks: 11)
 └── 09 quic-pool ─────── (blocks: 10)

09 + 04 done →
 └── 10 quic-sender ───── (blocks: 11)

07 + 08 + 10 done →
 └── 11 tpu-client ────── (blocks: 12, 13, 14, 15)

11 done →
 ├── 12 confirm
 ├── 13 barrel (index.ts)
 └── 14 unit tests (some can start earlier — see batches)

12 + 13 done → 15 integration + docs
```

## Batches

**Batch 1** (1 agent, sequential prereq):
- 01 scaffold (haiku)

**Batch 2** (5 agents parallel, all depend only on 01):
- 02 errors+events (haiku)
- 03 addr (haiku)
- 04 research (opus)
- 05 route-snapshot (haiku)
- 06 identity (sonnet)

**Batch 3** (3 agents parallel):
- 07 slot-tracker (sonnet) — deps: 02
- 08 leader-cache (sonnet) — deps: 02, 03
- 09 quic-pool (sonnet) — deps: 02, 05

**Batch 4** (1 agent):
- 10 quic-sender (sonnet) — deps: 02, 03, 04, 06, 09

**Batch 5** (1 agent):
- 11 tpu-client (sonnet) — deps: 02, 05, 06, 07, 08, 10

**Batch 6** (3 agents parallel):
- 12 confirm (sonnet) — deps: 11
- 13 index.ts barrel (haiku) — deps: 11
- 14 unit tests (sonnet) — deps: 03, 05, 07, 08 (can partially start in batch 4, but simpler to batch here)

**Batch 7** (1 agent):
- 15 integration + docs (sonnet) — deps: 12, 13

Total: 7 batches, 15 agents, ~10 hot-path sequential dependencies.

## Shared-file analysis

No concerns share TOUCHES files — each concern creates/owns distinct files. Exceptions:
- 01 creates `src/` and `test/` dirs; all later concerns write *into* these but own their own files.
- 13 (barrel) reads public types from 02, 06, 07, 08, 10, 11, 12. Sequencing via batches handles this.
- 15 writes README.md which references the public API — must land after 13 publishes it.

No parallel edits to the same file.

## Blocker verification (VERIFY_BLOCKER)

Each concern file lists its BLOCKED_BY with a 30-second check — e.g., `ls src/errors.ts` or `grep -q 'export type TpuError' src/errors.ts`.

## Open-question resolution

Concern 04 (research) resolves DESIGN.md open questions BEFORE concerns 09/10 consume them:
1. `@matrixai/quic` `verifyCallback` signature in current npm version
2. Peer cert DER parse approach for SPKI Ed25519 extraction (test fixture from a live validator cert)
3. Firedancer ALPN/cert empirical check (optional — note if can't hit live node)
4. kit 3.x `Commitment` type (for concern 12)

If 04 discovers a blocker (e.g., verifyCallback doesn't expose raw cert bytes), surface it and re-plan before batch 4.

## Status — COMPLETE (2026-04-13)

All 15 concerns shipped on branch `rewrite/kit-v3`. Batch summary:

| Batch | Agents | Result |
|---|---|---|
| 1 | 1 (haiku) | scaffold ✓ |
| 2 | 5 parallel (haiku + sonnet + opus) | foundation + research ✓ |
| 3 | 3 parallel (sonnet) | core modules ✓ |
| 4 | 1 (sonnet) | quic-sender ✓ |
| 5 | 1 (sonnet) | orchestration ✓ |
| 6 | 3 parallel (haiku + sonnet) | confirm + barrel + tests ✓ |
| 7 | 1 (sonnet) | integration + docs ✓ |
| audit | 1 (opus) | 2 criticals + 6 significants + 7 minors found |
| fixer | 1 (sonnet) | all criticals + significants fixed |

**Verification:**
- `npx tsc --noEmit` — 0 errors (src + tests)
- `npx vitest run test/unit` — 45/45 passing
- `npx tsc && node -e "import('./lib/index.js')"` — ESM entry resolves
- Public API: `createTpuClient`, `sendAndConfirmTpuTransactionFactory`, `buildIdentity`, `ed25519KeyPairFromSeed`, `ed25519KeyPairFromSolanaSecret`, `TpuSendError` + full type exports

**Known limitations (tracked in follow-up):**
- Integration test exists but gated behind `TPU_INTEGRATION=1`; requires `solana-test-validator` on PATH — not run in CI yet.
- `stakedIdentities` set in tpu-client is unpopulated; `maxStreamsPerConn.staked` currently unused pending `getVoteAccounts` integration.
- Firedancer ALPN verification on a live node (NOTES-04 Q3) still pending manual smoke test.
- Quarantine set is cleared on `cluster-refresh` (5min) as a practical proxy for epoch rotation; exact epoch-change detection is a follow-up.

