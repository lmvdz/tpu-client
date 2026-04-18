import type { Address } from '@solana/kit';

// ---------------------------------------------------------------------------
// Per-leader attempt errors (RT3-S3)
// ---------------------------------------------------------------------------

/**
 * Error describing why a single leader attempt failed.
 *
 * - `connect-timeout` — QUIC handshake did not complete within the configured timeout.
 * - `write-timeout` — stream write stalled before completing.
 * - `cert-pin-mismatch` — server cert SPKI didn't match the gossip identity (strict mode).
 * - `backpressure` — connection had no available streams (max-streams reached).
 * - `no-tpu-addr` — no TPU QUIC address is known for this validator.
 * - `transport` — unexpected transport-level error; see `cause` for details.
 * - `quarantined` — identity is in the cert-pin quarantine list.
 */
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

/**
 * Reason a `sendRawTransaction` call failed entirely (not a per-leader error).
 *
 * - `aborted` — the client was closed or the caller's AbortSignal fired.
 * - `no-leaders` — leader snapshot was empty at send time.
 * - `all-failed` — every leader in the fan-out set returned a {@link TpuLeaderError}.
 * - `invalid-tx` — transaction bytes failed pre-flight validation.
 */
export type TpuSendFailure =
  | { kind: 'aborted' }
  | { kind: 'no-leaders' }
  | { kind: 'all-failed'; attempts: number }
  | { kind: 'invalid-tx'; reason: string };

// ---------------------------------------------------------------------------
// F8: rpc-error kind for background refresh loop errors.
// slot-subscription is reserved for actual slot-tracker subscription errors.
// ---------------------------------------------------------------------------

/**
 * Error emitted when a background RPC call fails.
 * `source` identifies which refresh loop produced the error.
 */
export type TpuRpcError =
  | { kind: 'rpc-error'; source: 'leader-cache' | 'stake-refresh' | 'cluster-refresh' | 'epoch-info'; cause: string };

// ---------------------------------------------------------------------------
// Backward-compat union — callers who catch TpuSendError and match .kind still work.
// ---------------------------------------------------------------------------

/**
 * Union of all error payloads that may appear inside a `{type:'error'}` {@link TpuEvent}
 * or be thrown as a {@link TpuSendError}.
 */
export type TpuError =
  | TpuLeaderError
  | TpuSendFailure
  | TpuRpcError
  | { kind: 'slot-subscription'; cause: string };

/**
 * Thrown by {@link TpuClient.sendRawTransaction} when the send cannot be completed.
 * Inspect `.details.kind` to distinguish the failure reason.
 */
export class TpuSendError extends Error {
  constructor(readonly details: TpuSendFailure, message?: string) {
    super(message ?? `TPU send failed: ${details.kind}`);
    this.name = 'TpuSendError';
  }
}
