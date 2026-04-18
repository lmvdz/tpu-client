import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSlotTracker } from '../../src/slot-tracker.js';
import type { TpuEvent } from '../../src/events.js';

// Helper: create a controllable async iterable for slot notifications
function createControlledNotifications() {
  const queue: any[] = [];
  const waiters: ((val: IteratorResult<any>) => void)[] = [];
  let done = false;

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<any>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<any>> {
          done = true;
          for (const w of waiters) w({ value: undefined, done: true });
          waiters.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  function push(value: any) {
    if (waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter({ value, done: false });
    } else {
      queue.push(value);
    }
  }

  function close() {
    done = true;
    for (const w of waiters) w({ value: undefined, done: true });
    waiters.length = 0;
  }

  return { iterable, push, close };
}

describe('slot-tracker', () => {
  let abortController: AbortController;
  const events: TpuEvent[] = [];
  const emit = (e: TpuEvent) => events.push(e);

  beforeEach(() => {
    abortController = new AbortController();
    events.length = 0;
  });

  afterEach(() => {
    abortController.abort();
    vi.useRealTimers();
  });

  it('resolves ready after 12 notifications', async () => {
    const { iterable, push } = createControlledNotifications();

    const fakeRpc = {
      getSlot: () => ({ send: async () => 999n }),
    };
    const fakeSubs = {
      slotNotifications: () => ({
        subscribe: async () => iterable,
      }),
    };

    const tracker = await createSlotTracker({
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      emit,
      signal: abortController.signal,
    });

    // Push 12 notifications
    for (let i = 1; i <= 12; i++) {
      push({ slot: BigInt(100 + i), parent: BigInt(99 + i), root: BigInt(98 + i) });
    }

    await tracker.ready;
    expect(tracker.estimate()).toBe(112n);
  });

  it('resolves ready via fallback when no WS events', async () => {
    vi.useFakeTimers();
    const { iterable } = createControlledNotifications();

    const fakeRpc = {
      getSlot: () => ({ send: async () => 500n }),
    };
    const fakeSubs = {
      slotNotifications: () => ({
        subscribe: async () => iterable,
      }),
    };

    const tracker = await createSlotTracker({
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      emit,
      signal: abortController.signal,
    });

    // Advance time past POLL_MS (400ms) and STALL_MS (2000ms)
    await vi.advanceTimersByTimeAsync(2500);

    await tracker.ready;
    expect(tracker.estimate()).toBe(500n);
  });

  it('emits slot-stall after 2s of no events', async () => {
    vi.useFakeTimers();
    const { iterable } = createControlledNotifications();

    const fakeRpc = {
      getSlot: () => ({ send: async () => 500n }),
    };
    const fakeSubs = {
      slotNotifications: () => ({
        subscribe: async () => iterable,
      }),
    };

    await createSlotTracker({
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      emit,
      signal: abortController.signal,
    });

    await vi.advanceTimersByTimeAsync(2500);

    const stallEvents = events.filter((e) => e.type === 'slot-stall');
    expect(stallEvents.length).toBeGreaterThan(0);
  });

  it('detects skipped slots', async () => {
    const { iterable, push } = createControlledNotifications();

    const fakeRpc = {
      getSlot: () => ({ send: async () => 999n }),
    };
    const fakeSubs = {
      slotNotifications: () => ({
        subscribe: async () => iterable,
      }),
    };

    await createSlotTracker({
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      emit,
      signal: abortController.signal,
    });

    // slot=100, parent=97 → skipped = 100 - 97 - 1 = 2
    push({ slot: 100n, parent: 97n, root: 95n });

    // Wait for the notification to be processed
    await new Promise((r) => setTimeout(r, 10));

    const slotEvents = events.filter((e) => e.type === 'slot') as any[];
    expect(slotEvents.length).toBeGreaterThan(0);
    expect(slotEvents[0].skipped).toBe(2);
  });

  it('RT2-C3: resubscribes after notification iterator rejection', async () => {
    vi.useFakeTimers();

    let subscribeCount = 0;

    // First subscription: immediately throws on first next() call.
    function makeRejectingIterable() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<any>> {
              return Promise.reject(new Error('ws disconnected'));
            },
            return(): Promise<IteratorResult<any>> {
              return Promise.resolve({ value: undefined, done: true as const });
            },
          };
        },
      };
    }

    const { iterable: goodIterable } = createControlledNotifications();

    const fakeRpc = {
      getSlot: () => ({ send: async () => 999n }),
    };
    const fakeSubs = {
      slotNotifications: () => ({
        subscribe: async () => {
          subscribeCount++;
          if (subscribeCount === 1) return makeRejectingIterable();
          return goodIterable;
        },
      }),
    };

    await createSlotTracker({
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      emit,
      signal: abortController.signal,
    });

    // Flush microtasks so first subscription attempt runs and fails.
    await Promise.resolve();
    await Promise.resolve();

    // First subscription should have errored and emitted a slot-subscription error.
    const errEvents = events.filter((e) => e.type === 'error');
    expect(errEvents.length).toBeGreaterThan(0);
    expect(subscribeCount).toBe(1);

    // Advance 2s backoff so resubscribe fires.
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(subscribeCount).toBe(2);

    // estimate should reflect the good subscription slots
    // (Note: tracker.ready may already be resolved via fallback poll; just confirm subscribeCount)
    expect(subscribeCount).toBe(2);
  });

  it('F15: slot-stall fires at most once per stall period', async () => {
    vi.useFakeTimers();
    const { iterable } = createControlledNotifications();

    const fakeRpc = {
      // Make getSlot hang so we don't resolve and reset stallEmitted.
      getSlot: () => ({ send: (): Promise<bigint> => new Promise(() => {}) }),
    };
    const fakeSubs = {
      slotNotifications: () => ({
        subscribe: async () => iterable,
      }),
    };

    const stallEvents: any[] = [];
    const localEmit = (e: any) => {
      if (e.type === 'slot-stall') stallEvents.push(e);
    };

    await createSlotTracker({
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      emit: localEmit,
      signal: abortController.signal,
    });

    // Advance 5 seconds — watchdog fires every 400ms, but stall-emit only once.
    await vi.advanceTimersByTimeAsync(5_000);

    // Should have emitted exactly 1 slot-stall event.
    expect(stallEvents.length).toBe(1);
  });

  it('abort signal closes subscription loop', async () => {
    const { iterable, push } = createControlledNotifications();

    const fakeRpc = {
      getSlot: () => ({ send: async () => 999n }),
    };
    const fakeSubs = {
      slotNotifications: () => ({
        subscribe: async () => iterable,
      }),
    };

    await createSlotTracker({
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      emit,
      signal: abortController.signal,
    });

    push({ slot: 100n, parent: 99n, root: 98n });
    abortController.abort();

    // Should not throw after abort
    await new Promise((r) => setTimeout(r, 20));
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(0);
  });
});
