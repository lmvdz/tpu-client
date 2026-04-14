import type { Address } from '@solana/kit';

export type TpuError =
  | { kind: 'connect-timeout'; identity: Address }
  | { kind: 'write-timeout'; identity: Address }
  | { kind: 'cert-pin-mismatch'; identity: Address; expected: string; got: string }
  | { kind: 'backpressure'; identity: Address }
  | { kind: 'no-tpu-addr'; identity: Address }
  | { kind: 'transport'; identity: Address; cause: string }
  | { kind: 'aborted' }
  | { kind: 'no-leaders' }
  | { kind: 'all-failed'; attempts: number }
  | { kind: 'quarantined'; identity: Address }
  | { kind: 'slot-subscription'; cause: string };

export class TpuSendError extends Error {
  constructor(readonly details: TpuError, message?: string) {
    super(message ?? `TPU send failed: ${details.kind}`);
    this.name = 'TpuSendError';
  }
}
