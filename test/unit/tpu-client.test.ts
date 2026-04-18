/**
 * Unit tests for tpu-client input validation (F1, F5).
 * These tests do NOT reach the QUIC layer — validation fires before any async work.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTpuClient } from '../../src/tpu-client.js';
import { TpuSendError } from '../../src/errors.js';
import type { Address } from '@solana/kit';

// ---------------------------------------------------------------------------
// Stub RPC / RpcSubscriptions that hang forever — won't be reached for
// validation tests, but createTpuClient needs them in its signature.
// ---------------------------------------------------------------------------

function makeAddr(label: string): Address {
  return `${label}${'1'.repeat(44 - label.length)}` as Address;
}

function makeStubDeps() {
  // Controlled iterable that never emits (so we can abort immediately).
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<never>> {
          return new Promise(() => {}); // never resolves
        },
        return(): Promise<IteratorResult<never>> {
          return Promise.resolve({ value: undefined as never, done: true as const });
        },
      };
    },
  };

  const fakeRpc = {
    getSlot: () => ({ send: async () => 100n }),
    getClusterNodes: () => ({ send: async () => [] }),
    getVoteAccounts: () => ({
      send: async () => ({ current: [], delinquent: [] }),
    }),
    getEpochInfo: () => ({
      send: async () => ({
        epoch: 1n,
        absoluteSlot: 432000n,
        slotIndex: 0n,
        slotsInEpoch: 432000n,
        transactionCount: 0n,
      }),
    }),
    getEpochSchedule: () => ({
      send: async () => ({
        slotsPerEpoch: 432000n,
        leaderScheduleSlotOffset: 432000n,
        warmup: false,
        firstNormalEpoch: 14n,
        firstNormalSlot: 524256n,
      }),
    }),
    getSlotLeaders: () => ({
      send: async () => [makeAddr('V1'), makeAddr('V2'), makeAddr('V3'), makeAddr('V4')],
    }),
  };

  const fakeSubs = {
    slotNotifications: () => ({
      subscribe: async () => iterable,
    }),
  };

  return { fakeRpc, fakeSubs };
}

// ---------------------------------------------------------------------------
// sendRawTransaction tx validation (F1, pre-existing guards)
// ---------------------------------------------------------------------------

describe('sendRawTransaction tx validation', () => {
  afterEach(() => vi.useRealTimers());

  async function makeClient(ac: AbortController) {
    const { fakeRpc, fakeSubs } = makeStubDeps();
    const client = await createTpuClient({
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      signal: ac.signal,
    });
    // The tx guards (F1) fire synchronously before any leader/pool access.
    return client;
  }

  it('throws invalid-tx for empty Uint8Array (length < 65)', async () => {
    const ac = new AbortController();
    const client = await makeClient(ac);
    try {
      await expect(
        client.sendRawTransaction(new Uint8Array(10)),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof TpuSendError &&
          e.details.kind === 'invalid-tx' &&
          (e.details as any).reason.includes('too short'),
      );
    } finally {
      ac.abort();
    }
  });

  it('throws invalid-tx for tx[0] === 0 (zero signatures)', async () => {
    const ac = new AbortController();
    const client = await makeClient(ac);
    try {
      const tx = new Uint8Array(100);
      tx[0] = 0;
      await expect(client.sendRawTransaction(tx)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof TpuSendError &&
          e.details.kind === 'invalid-tx' &&
          (e.details as any).reason.includes('zero signatures'),
      );
    } finally {
      ac.abort();
    }
  });

  it('throws invalid-tx for tx[0] >= 0x80 (>=128 sigs)', async () => {
    const ac = new AbortController();
    const client = await makeClient(ac);
    try {
      const tx = new Uint8Array(100);
      tx[0] = 0x80;
      await expect(client.sendRawTransaction(tx)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof TpuSendError &&
          e.details.kind === 'invalid-tx',
      );
    } finally {
      ac.abort();
    }
  });
});

// ---------------------------------------------------------------------------
// createTpuClient option validation (F5)
// ---------------------------------------------------------------------------

describe('createTpuClient option validation', () => {
  function makeMinimalOpts(overrides?: Record<string, unknown>) {
    const { fakeRpc, fakeSubs } = makeStubDeps();
    return {
      rpc: fakeRpc as any,
      rpcSubscriptions: fakeSubs as any,
      ...overrides,
    };
  }

  it('throws TypeError for fanoutSlots=0', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({ fanoutSlots: 0 })),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError for fanoutSlots=100', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({ fanoutSlots: 100 })),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError for fanoutSlots=-1', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({ fanoutSlots: -1 })),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError for fanoutSlots=1.5 (non-integer)', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({ fanoutSlots: 1.5 })),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError for poolCap=0', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({ poolCap: 0 })),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError for poolCap=-5', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({ poolCap: -5 })),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError for maxStreamsPerConn.staked=0', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({
        maxStreamsPerConn: { staked: 0, unstaked: 8 },
      })),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError for maxStreamsPerConn.unstaked=0', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({
        maxStreamsPerConn: { staked: 128, unstaked: 0 },
      })),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError for maxStreamsPerConn.staked=-1', async () => {
    await expect(
      createTpuClient(makeMinimalOpts({
        maxStreamsPerConn: { staked: -1, unstaked: 8 },
      })),
    ).rejects.toThrow(TypeError);
  });
});
