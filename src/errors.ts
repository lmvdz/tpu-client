import type { Address } from '@solana/kit';

// ---------------------------------------------------------------------------
// Per-leader attempt errors (RT3-S3)
// ---------------------------------------------------------------------------

export type TpuLeaderError =
  | { kind: 'connect-timeout'; identity: Address }
  | { kind: 'write-timeout'; identity: Address }
  | { kind: 'cert-pin-mismatch'; identity: Address; expected: string; got: string }
  | { kind: 'backpressure'; identity: Address }
  | { kind: 'no-tpu-addr'; identity: Address }
  | { kind: 'transport'; identity: Address; cause: string }
  | { kind: 'quarantined'; identity: Address };

// ---------------------------------------------------------------------------
// Top-level send failure (RT3-S3)
// ---------------------------------------------------------------------------

export type TpuSendFailure =
  | { kind: 'aborted' }
  | { kind: 'no-leaders' }
  | { kind: 'all-failed'; attempts: number }
  | { kind: 'invalid-tx'; reason: string };

// ---------------------------------------------------------------------------
// F8: rpc-error kind for background refresh loop errors.
// slot-subscription is reserved for actual slot-tracker subscription errors.
// ---------------------------------------------------------------------------

export type TpuRpcError =
  | { kind: 'rpc-error'; source: 'leader-cache' | 'stake-refresh' | 'cluster-refresh' | 'epoch-info'; cause: string };

// ---------------------------------------------------------------------------
// Backward-compat union — callers who catch TpuSendError and match .kind still work.
// ---------------------------------------------------------------------------

export type TpuError =
  | TpuLeaderError
  | TpuSendFailure
  | TpuRpcError
  | { kind: 'slot-subscription'; cause: string };

export class TpuSendError extends Error {
  constructor(readonly details: TpuSendFailure, message?: string) {
    super(message ?? `TPU send failed: ${details.kind}`);
    this.name = 'TpuSendError';
  }
}
