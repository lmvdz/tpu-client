import type { Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi } from '@solana/kit';
import type { EventEmitter } from './events.js';

const MIN_SAMPLES = 12;
const STALL_MS = 2_000;
const POLL_MS = 400;

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

  // F16: plain counter replaces the typed ring buffer (only sampleCount was used for gating).
  let sampleCount = 0;
  let lastSlotMs = 0;
  let currentEstimate: bigint | null = null;
  let pollFallbackActive = false;
  // F15: track whether a stall event has been emitted; don't re-fire until isFresh() recovers.
  let stallEmitted = false;

  const { promise: readyPromise, resolve: resolveReady } = createOnceResolver();

  // Drive notification loop in background with resubscribe on error (RT2-C3).
  // The initial subscribe() call is inside the loop so the tracker is returned
  // before subscription succeeds — readyResolvers pattern handles this.
  void (async () => {
    while (!signal.aborted) {
      try {
        const notifications = await rpcSubscriptions
          .slotNotifications()
          .subscribe({ abortSignal: signal });
        for await (const n of notifications) {
          // Slot, parent, root are already bigint (Slot = bigint in @solana/rpc-types).
          const slot = n.slot;
          const parent = n.parent;
          const skipped = Number(slot - parent - 1n);
          sampleCount++;
          lastSlotMs = Date.now();
          currentEstimate = slot;
          // F15: clear stall state on fresh slot events.
          if (stallEmitted) {
            stallEmitted = false;
          }
          emit({ type: 'slot', slot, parent, skipped: Math.max(0, skipped) });
          if (sampleCount >= MIN_SAMPLES) resolveReady();
        }
      } catch (err) {
        if (signal.aborted) return;
        emit({ type: 'error', error: { kind: 'slot-subscription', cause: String(err) } });
        // Backoff before resubscribe — don't hot-loop a busted endpoint.
        await new Promise<void>((r) => setTimeout(r, 2_000));
      }
    }
  })();

  // Stall watchdog + cold-start fallback — runs every POLL_MS, cheap when fresh.
  startStallWatchdog(signal, async () => {
    if (signal.aborted) return;
    const ageMs = lastSlotMs === 0 ? Infinity : Date.now() - lastSlotMs;
    if (ageMs > STALL_MS) {
      pollFallbackActive = true;
      // F15: emit slot-stall only once per stall period; don't re-fire until isFresh() recovers.
      if (!stallEmitted) {
        stallEmitted = true;
        emit({ type: 'slot-stall', lastSlotAgeMs: Number.isFinite(ageMs) ? ageMs : STALL_MS });
      }
      try {
        const slot = await rpc.getSlot({ commitment: 'processed' }).send({ abortSignal: signal });
        currentEstimate = slot;
        const isColdStart = lastSlotMs === 0;
        // RT2-C3: update lastSlotMs so isFresh() returns true after successful poll.
        lastSlotMs = Date.now();
        // F15: reset stall flag since we got a fresh slot via polling.
        stallEmitted = false;
        if (isColdStart) resolveReady(); // cold-start fallback
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
