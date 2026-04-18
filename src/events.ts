import type { Address, Signature } from '@solana/kit';
import type { TpuError, TpuLeaderError } from './errors.js';

/**
 * Result of a single send attempt to one leader.
 * Discriminate on `ok`: `true` means the stream write succeeded (with RTT);
 * `false` means it failed with a {@link TpuLeaderError}.
 */
export type LeaderAttempt =
  | { identity: Address; tpuQuicAddr: string; ok: true; rttMs: number }
  | { identity: Address; tpuQuicAddr: string; ok: false; error: TpuLeaderError };

/**
 * Union of all observable events emitted by a {@link TpuClient}.
 *
 * - `ready` — client finished init; snapshot and slot tracker are live.
 * - `slot` — new slot notification from the subscription feed.
 * - `slot-stall` — no slot update received for an unusually long time.
 * - `leaders-refresh` — leader window snapshot was rebuilt.
 * - `cluster-refresh` — cluster node map refreshed (~5-minute cadence).
 * - `conn-open` — a new QUIC connection was opened to a validator.
 * - `conn-close` — a QUIC connection was closed.
 * - `conn-evict` — a connection was evicted from the pool.
 * - `cert-pin-mismatch` — server cert SPKI did not match the gossip identity.
 * - `send` — a transaction was submitted to the leader fan-out set.
 * - `error` — a background loop error (rpc-error, slot-subscription, etc.).
 * - `stale-snapshot` — leader snapshot hasn't refreshed in > 2 × tick interval.
 * - `ephemeral-identity` — no staked identity was supplied; an ephemeral TLS cert is in use.
 */
export type TpuEvent =
  | { type: 'ready' }
  | { type: 'slot'; slot: bigint; parent: bigint; skipped: number }
  | { type: 'slot-stall'; lastSlotAgeMs: number }
  | { type: 'leaders-refresh'; startSlot: bigint; count: number; source: 'slotLeaders' | 'union' }
  | { type: 'cluster-refresh'; nodes: number }
  | { type: 'conn-open'; identity: Address }
  | { type: 'conn-close'; identity: Address; reason?: string }
  | { type: 'conn-evict'; identity: Address; reason: string }
  | { type: 'cert-pin-mismatch'; identity: Address; expected: string; got: string }
  | { type: 'send'; signature: Signature; attempts: LeaderAttempt[] }
  | { type: 'error'; error: TpuError }
  // F7: stale-snapshot event — emitted when refresh loop errors and snapshot age > 2*TICK_MS.
  | { type: 'stale-snapshot'; lastRefreshAgeMs: number; reason: string }
  // F9: ephemeral-identity — replaces console.warn for unstaked identity.
  | { type: 'ephemeral-identity' };

/** Callback invoked with each {@link TpuEvent}. Pass to `CreateTpuClientOptions.onEvent`. */
export type EventEmitter = (e: TpuEvent) => void;

/** No-op {@link EventEmitter} used as the default when no `onEvent` is supplied. */
export const noopEmitter: EventEmitter = () => {};
