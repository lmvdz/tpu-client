# Design: TPU Client Rewrite on @solana/kit 3.x

## Approach

A TPU-direct transaction submission client built on `@solana/kit` 3.x RPC/subscription primitives plus `@matrixai/quic` for stake-weighted QUIC transport. The client accepts a user-supplied Ed25519 identity keypair (the QoS identity), mints an X.509 leaf cert with `@peculiar/x509`, fans out to the next N leaders' TPU-QUIC endpoints, and returns a per-attempt result. Confirmation is provided via a dedicated `sendAndConfirmTpuTransactionFactory` that mirrors kit's confirmation state machine — we do NOT pretend to plug into kit's `sendAndConfirmTransactionFactory`, which does not take a pluggable sender.

The client is split into small, individually-testable modules with a single immutable `RouteSnapshot` shared between the refresh loop and hot-path send via atomic pointer swap plus refcounted connections. Lifecycle is AbortSignal + explicit `close()` drain.

## Key Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Confirmation API | Ship `sendAndConfirmTpuTransactionFactory` | Reuse kit's factory | Kit's factory has no pluggable sender hook (RT-A#1). |
| QoS identity | User-supplied `CryptoKeyPair` (Ed25519), required for staked QoS; optional → ephemeral unstaked | Throwaway only | Stake-weighted QoS keys off client cert identity (RT-A#2). |
| X.509 minting | `@peculiar/x509` (keep) | node:crypto / selfsigned | node:crypto cannot mint X.509; selfsigned is RSA-only. |
| Server pin | SPKI-DER extract via `@peculiar/x509`, match node identity pubkey | Manual DER | Same lib both sides, ~same cost. |
| Slot source | `slotNotifications` + `RecentLeaderSlots` estimator, cold-start fallback `getSlot` (400ms cache) until K=12 samples; also stall fallback if >2s silence | WS only | Cold start + WS stalls give torn routes (RT-B#2, RT-B#4). |
| Skip detection | Infer from `parent`/`slot` delta in `slotNotifications` (delta > 1 ⇒ skips) | None | Native field absent (RT-A#6). |
| Leader discovery | `getSlotLeaders(start,limit)` clamped at epoch end + union with `getLeaderSchedule(nextEpoch)` within 64 slots of boundary | Single call | Boundary call errors otherwise (RT-B#3). |
| Route sharing | Immutable `RouteSnapshot` behind atomic ref; refcounted connections; evict only when refcount=0 after grace | Mutex | Lock-free hot path, no use-after-close (RT-B#1). |
| Pool | Per-leader-identity, LRU cap 1024, 30s idle evict, aggressive eviction of non-upcoming leaders | Unbounded | Memory + socket bound (RT-A#5). |
| Backpressure | Per-connection stream semaphore (128 staked / 8 unstaked default), reject-fast `BackpressureError` | Queue | Prevents head-of-line and OOM (RT-B#5). |
| Cert-pin failure | Distinct `cert-pin-mismatch` event, leader quarantined for epoch, never silent-retry same node | Retry | Likely MITM/misconfig (RT-B#9). |
| Return shape | `{signature, attempts: LeaderAttempt[]}` | signature only | Preserves partial-success detail (RT-A#8). |
| Lifecycle | Both `AbortSignal` and `close(): Promise<void>` (drain) | One only | Abort = cancel, close = drain (RT-A#12, RT-B#12). |
| Partial-init | `AsyncDisposableStack` inside `createTpuClient` | ad-hoc | Clean on throw (RT-B#12). |
| Package | ESM-only, `engines: node >=22.11` | Node 20 | Node 20 EOL 2026-04-30 (RT-B#7). |
| Deps dropped | `selfsigned`, `@peculiar/webcrypto`, `@solana/web3.js`, `bs58` | — | Replaced by kit + `@peculiar/x509` + global WebCrypto. |
| Observability | `onEvent: (e: TpuEvent) => void` | metrics only | Stable union, caller maps to metrics (RT-B#6). |
| ALPN | `applicationProtos: ['solana-tpu']` | — | Accepted (RT-A#4), verify vs Firedancer in impl. |
| Host parse | URL-based, supports IPv6 brackets, hostname SRV-less; `tpu` → fallback `tpu+6` | split(':') | Correctness (RT-B#10). |

## Public API

```ts
export interface CreateTpuClientOptions {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  identity?: CryptoKeyPair;        // Ed25519; omit = ephemeral unstaked
  fanoutSlots?: number;            // default 4
  maxStreamsPerConn?: { staked: number; unstaked: number }; // default {128, 8}
  poolCap?: number;                // default 1024
  onEvent?: (e: TpuEvent) => void;
  signal?: AbortSignal;
}

export interface TpuClient {
  readonly ready: Promise<void>;   // resolves when slot source is primed
  sendRawTransaction(
    tx: Uint8Array,
    opts?: { signal?: AbortSignal; fanoutSlots?: number }
  ): Promise<SendResult>;
  close(): Promise<void>;          // drain in-flight; idempotent
}

export interface SendResult {
  signature: Signature;            // base58 kit Signature
  attempts: LeaderAttempt[];
}
export interface LeaderAttempt {
  identity: Address;
  tpuQuicAddr: string;
  ok: boolean;
  error?: TpuError;
  rttMs?: number;
}

export type TpuError =
  | { kind: 'connect-timeout'; identity: Address }
  | { kind: 'write-timeout'; identity: Address }
  | { kind: 'cert-pin-mismatch'; identity: Address; expected: string; got: string }
  | { kind: 'backpressure'; identity: Address }
  | { kind: 'no-tpu-addr'; identity: Address }
  | { kind: 'transport'; identity: Address; cause: string }
  | { kind: 'aborted' }
  | { kind: 'no-leaders' };

export type TpuEvent =
  | { type: 'ready' }
  | { type: 'slot'; slot: bigint; parent: bigint; skipped: number }
  | { type: 'slot-stall'; lastSlotAgeMs: number }
  | { type: 'leaders-refresh'; startSlot: bigint; count: number; source: 'schedule'|'slotLeaders'|'union' }
  | { type: 'cluster-refresh'; nodes: number }
  | { type: 'conn-open'|'conn-close'|'conn-evict'; identity: Address; reason?: string }
  | { type: 'cert-pin-mismatch'; identity: Address; expected: string; got: string }
  | { type: 'send'; signature: Signature; attempts: LeaderAttempt[] }
  | { type: 'error'; error: TpuError };

export interface LeaderDiscoveryProvider {
  getLeaders(slot: bigint, fanout: number): Promise<LeaderInfo[]>;
}
export interface LeaderInfo { identity: Address; tpuQuicAddr: string | null; stake?: bigint }

export function createTpuClient(o: CreateTpuClientOptions): Promise<TpuClient>;

export function sendAndConfirmTpuTransactionFactory(cfg: {
  tpu: TpuClient;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}): (tx: Uint8Array, opts: { commitment: Commitment; abortSignal: AbortSignal; lastValidBlockHeight: bigint })
    => Promise<{ signature: Signature; attempts: LeaderAttempt[] }>;
```

## Module Layout

```
src/
  index.ts                       // barrel: public API only
  tpu-client.ts                  // createTpuClient, orchestration
  leader-cache.ts                // LeaderDiscoveryProvider impl + epoch union
  slot-tracker.ts                // WS + estimator + cold/stall fallback + ready
  quic-sender.ts                 // @matrixai/quic wrap, verifyCallback, streams
  quic-pool.ts                   // per-identity pool, LRU, refcount, eviction
  identity.ts                    // keypair load, X.509 mint via @peculiar/x509
  route-snapshot.ts              // immutable snapshot + atomic swap
  confirm.ts                     // sendAndConfirmTpuTransactionFactory
  errors.ts                      // TpuError discriminated union
  events.ts                      // TpuEvent types, emit helper
  addr.ts                        // URL-based host:port parse, tpu+6 fallback
tests/
  unit/{slot-tracker,leader-cache,route-snapshot,addr}.test.ts
  integration/validator.test.ts  // solana-test-validator
```

## Concurrency Model

`RouteSnapshot` is frozen `{ asOfSlot, leaders: readonly LeaderInfo[], generation }`. A single `AtomicReference<RouteSnapshot>` is read once per `sendRawTransaction` call; all downstream work uses that snapshot. The refresh loop builds the next snapshot off-path and publishes via a single reference store.

Connections live in `QuicPool` keyed by `identity`. Each `ConnEntry = { conn, refcount, lastUse, state: 'open'|'draining'|'closed' }`. Send path:
1. `pool.acquire(identity)` → increments refcount, returns conn (opens if absent and under cap).
2. Send via stream, finally `pool.release(identity)` → decrement refcount.
3. Evictor thread picks entries where `refcount===0 && (idle>30s || !upcoming || lru-overflow)`, sets `state='draining'`, awaits any in-flight (refcount can't rise because map key swap makes new acquires open fresh), then closes. No use-after-close because `acquire` atomically checks `state==='open'`.

Backpressure: each conn holds an async semaphore of `maxStreams`; `tryAcquire` fails fast with `BackpressureError`, which counts as a failed attempt but does not abort the fan-out.

Stream cancellation: on `signal.aborted` we explicitly call `stream.cancel()` and release the semaphore slot to avoid leaks (RT-A#7).

## Startup & Readiness

`createTpuClient` returns only after: cluster nodes fetched once, subscription established, identity cert minted. `client.ready` resolves when either (a) estimator has K=12 slot samples OR (b) `getSlot` fallback has populated an initial slot (400ms TTL cache, refreshed while K samples accumulate). `sendRawTransaction` awaits `ready` internally on first call. `{type:'ready'}` event emitted.

Stall watchdog: if no `slotNotification` for >2s, flip to `getSlot` polling, emit `slot-stall`, recover silently when WS resumes.

## Epoch Boundary Handling

`LeaderDiscoveryProvider.getLeaders(slot, fanout)`:
- Compute `epochStart`, `epochEnd` from cached `EpochSchedule` (refreshed on epoch change).
- If `slot + fanout <= epochEnd`: single `getSlotLeaders(slot, fanout)`.
- Else: clamp to `epochEnd - slot + 1` leaders from `getSlotLeaders`; fetch `getLeaderSchedule(epoch+1)` (cached), compute leaders for slots `[epochEnd+1 .. slot+fanout-1]`, union preserving order. Emit `leaders-refresh` with `source: 'union'`. If next epoch schedule not yet published, retry with backoff up to 3×; on exhaustion return the clamped prefix only.

## Observability

All state transitions emit `TpuEvent` via `onEvent`. The union is the stable public schema — callers map to Prometheus/OpenTelemetry. `send` event always fires once per `sendRawTransaction`, with full `attempts[]`. `cert-pin-mismatch` is a separate event in addition to the failed attempt so ops can alert.

## Risks (known, accepted)

| Risk | Severity | Mitigation / Acceptance |
|---|---|---|
| `solana-test-validator` has 100% stake → staked-QoS path untested locally | Med | Integration tests assert transport correctness; staked-path validated via optional testnet CI job; document Firedancer manual verification. |
| `@matrixai/quic` native bindings incompatible with CF Workers / awkward on Lambda | Med | Document compat matrix in README; transport is isolated behind `quic-sender.ts` interface so a pluggable transport (e.g., WebTransport) can be added in v2.1 without API break. |
| IPv6 / hostname edge cases in `host:port` | Low | URL-based parser + unit tests; fix during impl. |
| `denque` vs inline ring contradiction in draft | Low | Use inline fixed-size ring in `RecentLeaderSlots`; drop `denque`. |
| `tpuQuic` null gossip entries | Low | Fallback to `tpu+6`; if both null, `no-tpu-addr` attempt, skip leader. |
| Semver impact | Low | Ship as `2.0.0`; maintain `1.x` branch 6 months with security-only fixes; CHANGELOG + MIGRATION.md. |
| Ephemeral unstaked identity = first dropped under load | Low | Documented; `identity` param encouraged in README. |

## Open Questions

- Exact `verifyCallback` signature in `@matrixai/quic` current release — confirm it receives peer cert chain as DER bytes; needed for SPKI pin.
- Firedancer TPU-QUIC ALPN string and cert expectations — verify `'solana-tpu'` matches; test on a Firedancer testnet endpoint before GA.
- `getLeaderSchedule(nextEpoch)` availability window relative to epoch boundary on mainnet vs testnet — tune clamp fallback retry count.
- Whether kit 3.x exposes a stable `Commitment` type for `confirm.ts` or we mirror string literals.
