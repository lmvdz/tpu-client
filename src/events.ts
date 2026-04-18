import type { Address, Signature } from '@solana/kit';
import type { TpuError, TpuLeaderError } from './errors.js';

export type LeaderAttempt =
  | { identity: Address; tpuQuicAddr: string; ok: true; rttMs: number }
  | { identity: Address; tpuQuicAddr: string; ok: false; error: TpuLeaderError };

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

export type EventEmitter = (e: TpuEvent) => void;

export const noopEmitter: EventEmitter = () => {};
