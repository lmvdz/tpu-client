# 02 — errors.ts + events.ts

STATUS: open
PRIORITY: p0
COMPLEXITY: mechanical
BLOCKED_BY: 01 (VERIFY: `test -f tsconfig.json && grep -q '"module": "NodeNext"' tsconfig.json`)
TOUCHES: src/errors.ts, src/events.ts

## Goal
Publish the stable public type unions used by every other module: `TpuError` (discriminated union) and `TpuEvent` (observability union). These are pure types with no runtime behavior — defined once, imported everywhere.

## Approach

Create **`src/errors.ts`** — exactly the union from [DESIGN.md#Public-API](DESIGN.md):

```ts
import type { Address } from '@solana/kit';

export type TpuError =
  | { kind: 'connect-timeout'; identity: Address }
  | { kind: 'write-timeout'; identity: Address }
  | { kind: 'cert-pin-mismatch'; identity: Address; expected: string; got: string }
  | { kind: 'backpressure'; identity: Address }
  | { kind: 'no-tpu-addr'; identity: Address }
  | { kind: 'transport'; identity: Address; cause: string }
  | { kind: 'aborted' }
  | { kind: 'no-leaders' };

export class TpuSendError extends Error {
  constructor(readonly details: TpuError, message?: string) {
    super(message ?? `TPU send failed: ${details.kind}`);
    this.name = 'TpuSendError';
  }
}
```

`TpuSendError` is the throwable wrapper for when `sendRawTransaction` fails outright (all leaders failed, no leaders known, aborted). Per-attempt failures use the plain `TpuError` union inside `LeaderAttempt.error`.

Create **`src/events.ts`**:

```ts
import type { Address, Signature } from '@solana/kit';
import type { TpuError } from './errors.js';

export interface LeaderAttempt {
  identity: Address;
  tpuQuicAddr: string;
  ok: boolean;
  error?: TpuError;
  rttMs?: number;
}

export type TpuEvent =
  | { type: 'ready' }
  | { type: 'slot'; slot: bigint; parent: bigint; skipped: number }
  | { type: 'slot-stall'; lastSlotAgeMs: number }
  | { type: 'leaders-refresh'; startSlot: bigint; count: number; source: 'schedule' | 'slotLeaders' | 'union' }
  | { type: 'cluster-refresh'; nodes: number }
  | { type: 'conn-open'; identity: Address }
  | { type: 'conn-close'; identity: Address; reason?: string }
  | { type: 'conn-evict'; identity: Address; reason: string }
  | { type: 'cert-pin-mismatch'; identity: Address; expected: string; got: string }
  | { type: 'send'; signature: Signature; attempts: LeaderAttempt[] }
  | { type: 'error'; error: TpuError };

export type EventEmitter = (e: TpuEvent) => void;

export const noopEmitter: EventEmitter = () => {};
```

## Rules

- NO runtime imports from kit — only `import type { Address, Signature } from '@solana/kit'`.
- Use `.js` extensions in imports (NodeNext/ESM requirement).
- Export every member `LeaderAttempt` consumers will need (`quic-sender`, `tpu-client`, `confirm`).
- No default exports.

## Verify

```bash
npx tsc --noEmit     # passes
grep -c "kind: '" src/errors.ts     # 8 variants
grep -c "type: '" src/events.ts     # 11 variants
```
