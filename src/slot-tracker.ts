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

  // Inline ring buffer of recent slots (BigInt64Array for efficiency).
  const samples = new BigInt64Array(MAX_SAMPLES);
  let sampleCount = 0;
  let sampleHead = 0;
  let lastSlotMs = 0;
  let currentEstimate: bigint | null = null;
  let pollFallbackActive = false;

  const { promise: readyPromise, resolve: resolveReady } = createOnceResolver();

  // Main WS subscription.
  const notifications = await rpcSubscriptions
    .slotNotifications()
    .subscribe({ abortSignal: signal });

  // Drive notification loop in background (fire-and-forget; signal governs teardown).
  void (async () => {
    try {
      for await (const n of notifications) {
        // Slot, parent, root are already bigint (Slot = bigint in @solana/rpc-types).
        const slot = n.slot;
        const parent = n.parent;
        const skipped = Number(slot - parent - 1n);
        recordSample(slot);
        lastSlotMs = Date.now();
        currentEstimate = slot;
        emit({ type: 'slot', slot, parent, skipped: Math.max(0, skipped) });
        if (sampleCount >= MIN_SAMPLES) resolveReady();
      }
    } catch (err) {
      if (!signal.aborted) {
        emit({ type: 'error', error: { kind: 'slot-subscription', cause: String(err) } });
      }
    }
  })();

  // Stall watchdog + cold-start fallback — runs every POLL_MS, cheap when fresh.
  startStallWatchdog(signal, async () => {
    if (signal.aborted) return;
    const ageMs = lastSlotMs === 0 ? Infinity : Date.now() - lastSlotMs;
    if (ageMs > STALL_MS) {
      pollFallbackActive = true;
      emit({ type: 'slot-stall', lastSlotAgeMs: Number.isFinite(ageMs) ? ageMs : STALL_MS });
      try {
        const slot = await rpc.getSlot({ commitment: 'processed' }).send({ abortSignal: signal });
        currentEstimate = slot;
        if (lastSlotMs === 0) resolveReady(); // cold-start fallback
      } catch {
        // keep stale estimate; next tick will retry
      }
    } else if (pollFallbackActive) {
      pollFallbackActive = false;
    }
  });

  return {
    ready: readyPromise,
    estimate(): bigint {
      if (currentEstimate === null) throw new Error('slot tracker not ready');
      return currentEstimate;
    },
    isFresh(): boolean {
      return lastSlotMs !== 0 && Date.now() - lastSlotMs < STALL_MS;
    },
  };

  function recordSample(slot: bigint): void {
    samples[sampleHead] = slot;
    sampleHead = (sampleHead + 1) % MAX_SAMPLES;
    if (sampleCount < MAX_SAMPLES) sampleCount++;
  }
}

function createOnceResolver(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((r) => {
    resolveFn = r;
  });
  let resolved = false;
  return {
    promise,
    resolve: () => {
      if (!resolved) {
        resolved = true;
        resolveFn();
      }
    },
  };
}

function startStallWatchdog(signal: AbortSignal, tick: () => Promise<void> | void): void {
  const id = setInterval(() => {
    if (signal.aborted) {
      clearInterval(id);
      return;
    }
    void tick();
  }, POLL_MS);
  signal.addEventListener('abort', () => clearInterval(id), { once: true });
}
