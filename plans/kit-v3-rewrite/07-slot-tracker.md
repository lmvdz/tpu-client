# 07 — slot-tracker.ts

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 02 (VERIFY: `grep -q 'slot-stall' src/events.ts`)
TOUCHES: src/slot-tracker.ts

## Goal
Maintain a best-estimate of the current Solana slot based on `slotNotifications` subscriptions, with a cold-start fallback to `getSlot` for the first ~6 seconds and a stall fallback when the WebSocket goes silent >2s. Expose a `ready` promise and emit `slot` / `slot-stall` events.

## Approach

```ts
import type { Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi } from '@solana/kit';
import type { EventEmitter } from './events.js';

const MIN_SAMPLES = 12;
const STALL_MS = 2_000;
const POLL_MS = 400;
const MAX_SAMPLES = 12;

export interface SlotTrackerOptions {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  emit: EventEmitter;
  signal: AbortSignal;
}

export interface SlotTracker {
  /** Resolves once estimator has MIN_SAMPLES samples OR a polling fallback populated a slot. */
  readonly ready: Promise<void>;
  /** Returns current best-estimate slot. Throws if never populated. */
  estimate(): bigint;
  /** Was the last slot event within STALL_MS? */
  isFresh(): boolean;
}

export async function createSlotTracker(opts: SlotTrackerOptions): Promise<SlotTracker> {
  const { rpc, rpcSubscriptions, emit, signal } = opts;

  // Ring buffer of recent slots (inline, drops denque dep).
  const samples = new BigInt64Array(MAX_SAMPLES);
  let sampleCount = 0;
  let sampleHead = 0;
  let lastSlotMs = 0;
  let currentEstimate: bigint | null = null;
  let pollFallbackActive = false;

  const readyResolvers = createReadyResolvers();

  // Main WS subscription.
  const notifications = await rpcSubscriptions
    .slotNotifications()
    .subscribe({ abortSignal: signal });

  // Drive notification loop in background (don't await — fire and forget, signal governs).
  (async () => {
    try {
      for await (const n of notifications) {
        const slot = BigInt(n.slot);
        const parent = BigInt(n.parent ?? n.slot);
        const skipped = Number(slot - parent - 1n);
        recordSample(slot);
        lastSlotMs = Date.now();
        currentEstimate = slot;
        emit({ type: 'slot', slot, parent, skipped: Math.max(0, skipped) });
        if (sampleCount >= MIN_SAMPLES) readyResolvers.resolve();
      }
    } catch (err) {
      if (!signal.aborted) emit({ type: 'error', error: { kind: 'transport', identity: '' as any, cause: String(err) } });
    }
  })();

  // Stall watchdog + cold-start fallback.
  startStallWatchdog(signal, async () => {
    if (signal.aborted) return;
    const ageMs = lastSlotMs === 0 ? Infinity : Date.now() - lastSlotMs;
    if (ageMs > STALL_MS) {
      pollFallbackActive = true;
      emit({ type: 'slot-stall', lastSlotAgeMs: Number.isFinite(ageMs) ? ageMs : STALL_MS });
      try {
        const slot = await rpc.getSlot({ commitment: 'processed' }).send({ abortSignal: signal });
        currentEstimate = BigInt(slot);
        if (lastSlotMs === 0) readyResolvers.resolve(); // cold-start fallback
      } catch { /* keep stale estimate */ }
    } else if (pollFallbackActive) {
      pollFallbackActive = false;
    }
  });

  return {
    ready: readyResolvers.promise,
    estimate(): bigint {
      if (currentEstimate === null) throw new Error('slot tracker not ready');
      return currentEstimate;
    },
    isFresh(): boolean {
      return lastSlotMs !== 0 && Date.now() - lastSlotMs < STALL_MS;
    },
  };

  function recordSample(slot: bigint) {
    samples[sampleHead] = slot;
    sampleHead = (sampleHead + 1) % MAX_SAMPLES;
    if (sampleCount < MAX_SAMPLES) sampleCount++;
  }
}

function createReadyResolvers() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  let resolved = false;
  return {
    promise,
    resolve: () => { if (!resolved) { resolved = true; resolve(); } },
  };
}

function startStallWatchdog(signal: AbortSignal, tick: () => Promise<void> | void) {
  const id = setInterval(async () => {
    if (signal.aborted) { clearInterval(id); return; }
    await tick();
  }, POLL_MS);
  signal.addEventListener('abort', () => clearInterval(id), { once: true });
}
```

## Decisions

- **Estimator**: the previous median/skip-distance estimator is overkill. `slotNotifications` is a firehose on every slot, and the network's own parent-gap exposes skips. Use "latest observed slot" directly. If this turns out to underperform (e.g., WS lags by multiple slots at high load), revisit with a skip-distance projection based on wall-clock elapsed.
- **Ring buffer**: kept for diagnostics + future skip-aware projection. `BigInt64Array` for efficiency.
- **Cold start**: `ready` resolves on the first `getSlot` success if WS is slow; sends can proceed with a less-current estimate. Acceptable.
- **Fallback loop**: runs every 400ms unconditionally (cheap); only calls `rpc.getSlot` when stale.

## Notes / open issues

- `slotNotifications` payload in kit 3.x: confirm it has `{ slot, parent, root }` — per red team A #6 (inference confirmed). If the shape differs, adjust `recordSample` / `emit`.
- The error branch in the notification loop uses a bogus `identity` of empty string — because `TpuError.transport` requires one. Consider adding a new variant `{kind: 'slot-subscription'; cause: string}` in concern 02 if cleaner. If concern 02 is already done, add a follow-up in the review cycle.

## Verify

```bash
npx tsc --noEmit
```

Unit tests (concern 14): simulate 12 slot events → ready resolves; simulate no events + getSlot succeeds → ready resolves via fallback; simulate WS silence >2s → `slot-stall` event emitted.
