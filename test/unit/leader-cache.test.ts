import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDefaultProvider, startLeaderCache } from '../../src/leader-cache.js';
import { AtomicSnapshotRef, EMPTY_SNAPSHOT } from '../../src/route-snapshot.js';
import type { TpuEvent } from '../../src/events.js';
import type { Address } from '@solana/kit';

const IDENTITY_A = 'LeaderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address;
const IDENTITY_B = 'LeaderBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address;
const IDENTITY_C = 'LeaderCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as Address;

// Minimal epoch schedule for normal (non-warmup) epochs
const epochSchedule = {
  slotsPerEpoch: 100n,
  firstNormalSlot: 0n,
  firstNormalEpoch: 0n,
};

// Current epoch: epoch 1, starts at slot 100, current slot = 100 (slotIndex=0), slotsInEpoch=100
function makeEpochInfo(epoch: bigint, absoluteSlot: bigint, slotIndex: bigint, slotsInEpoch: bigint) {
  return { epoch, absoluteSlot, slotIndex, slotsInEpoch };
}

describe('createDefaultProvider', () => {
  it('within epoch: only calls getSlotLeaders', async () => {
    const getSlotLeadersCalls: [bigint, number][] = [];
    const getLeaderScheduleCalls: bigint[] = [];

    // slot=100, fanout=5, epochEnd = 100+100-1 = 199 → all within epoch
    const epochInfo = makeEpochInfo(1n, 100n, 0n, 100n);

    const clusterNodes = new Map<Address, { tpu?: string | null; tpuQuic?: string | null }>([
      [IDENTITY_A, { tpuQuic: '1.2.3.4:8009' }],
    ]);

    const fakeRpc = {
      getSlotLeaders: (startSlot: bigint, count: number) => {
        getSlotLeadersCalls.push([startSlot, count]);
        return { send: async () => [IDENTITY_A, IDENTITY_A, IDENTITY_A, IDENTITY_A, IDENTITY_A] };
      },
      getLeaderSchedule: (slot: bigint) => {
        getLeaderScheduleCalls.push(slot);
        return { send: async () => null };
      },
    };

    const provider = createDefaultProvider(() => ({
      rpc: fakeRpc as any,
      clusterNodes,
      epochSchedule,
      currentEpoch: epochInfo,
    }));

    const result = await provider.getLeaders(100n, 5);
    expect(getSlotLeadersCalls).toHaveLength(1);
    expect(getSlotLeadersCalls[0]).toEqual([100n, 5]);
    expect(getLeaderScheduleCalls).toHaveLength(0);
    expect(result.leaders).toHaveLength(5);
    expect(result.source).toBe('slotLeaders');
  });

  it('cross-boundary: calls getSlotLeaders + getLeaderSchedule, returns 3+2=5 leaders', async () => {
    // slot=198, fanout=5, epochEnd=199 → 198,199 = 2 slots in epoch, need 3 more from next
    const epochInfo = makeEpochInfo(1n, 198n, 98n, 100n);
    // epochEnd = 198 - 98 + 100 - 1 = 199

    const clusterNodes = new Map<Address, { tpu?: string | null; tpuQuic?: string | null }>([
      [IDENTITY_A, { tpuQuic: '1.0.0.1:8009' }],
      [IDENTITY_B, { tpuQuic: '1.0.0.2:8009' }],
      [IDENTITY_C, { tpuQuic: '1.0.0.3:8009' }],
    ]);

    const fakeRpc = {
      getSlotLeaders: (startSlot: bigint, count: number) => {
        // return `count` entries
        return { send: async () => Array(count).fill(IDENTITY_A) };
      },
      getLeaderSchedule: () => {
        // Next epoch starts at slot 200 (epoch 2 * 100 = 200)
        // We need slots 200, 201, 202 from the next epoch
        // Schedule is relative to epoch start (slot index 0,1,2 → identities)
        // Slot type is bigint in @solana/rpc-types
        const sched: Record<string, bigint[]> = {
          [IDENTITY_B]: [0n, 1n],
          [IDENTITY_C]: [2n],
        };
        return { send: async () => sched };
      },
    };

    const provider = createDefaultProvider(() => ({
      rpc: fakeRpc as any,
      clusterNodes,
      epochSchedule,
      currentEpoch: epochInfo,
    }));

    const result = await provider.getLeaders(198n, 5);
    // 2 from current epoch + 3 from next epoch schedule
    expect(result.leaders).toHaveLength(5);
    expect(result.source).toBe('union');
  });

  it('next epoch schedule null → returns clamped leaders', async () => {
    // slot=198, fanout=5, epochEnd=199 → only 2 from current epoch possible
    const epochInfo = makeEpochInfo(1n, 198n, 98n, 100n);

    const clusterNodes = new Map<Address, { tpu?: string | null; tpuQuic?: string | null }>([
      [IDENTITY_A, { tpuQuic: '1.0.0.1:8009' }],
    ]);

    const fakeRpc = {
      getSlotLeaders: (startSlot: bigint, count: number) => {
        return { send: async () => Array(count).fill(IDENTITY_A) };
      },
      getLeaderSchedule: () => {
        return { send: async () => null };
      },
    };

    const provider = createDefaultProvider(() => ({
      rpc: fakeRpc as any,
      clusterNodes,
      epochSchedule,
      currentEpoch: epochInfo,
    }));

    const result = await provider.getLeaders(198n, 5);
    // Only 2 leaders (clamped to epoch end)
    expect(result.leaders).toHaveLength(2);
    expect(result.source).toBe('slotLeaders');
  });

  it('cluster node with tpuQuic=null but valid tpu → derives tpuQuicAddr', async () => {
    const epochInfo = makeEpochInfo(1n, 100n, 0n, 100n);
    const clusterNodes = new Map<Address, { tpu?: string | null; tpuQuic?: string | null }>([
      [IDENTITY_A, { tpu: '5.5.5.5:8003', tpuQuic: null }],
    ]);

    const fakeRpc = {
      getSlotLeaders: () => ({ send: async () => [IDENTITY_A] }),
      getLeaderSchedule: () => ({ send: async () => null }),
    };

    const provider = createDefaultProvider(() => ({
      rpc: fakeRpc as any,
      clusterNodes,
      epochSchedule,
      currentEpoch: epochInfo,
    }));

    const result = await provider.getLeaders(100n, 1);
    expect(result.leaders[0]?.tpuQuicAddr).toBe('5.5.5.5:8009');
  });
});

const STAKED_NODE = 'StakedNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN' as Address;
const DELINQUENT_NODE = 'DelinqNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN' as Address;
const UNSTAKED_NODE = 'UnstakNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN' as Address;

describe('startLeaderCache stakedIdentities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('populates stakedIdentities from current vote accounts; delinquent excluded', async () => {
    vi.useFakeTimers();

    const stakedIdentities = new Set<Address>();

    const fakeRpc = {
      getClusterNodes: () => ({
        send: async () => [
          { pubkey: STAKED_NODE as Address, tpu: '1.0.0.1:8003', tpuQuic: '1.0.0.1:8009' },
        ],
      }),
      getEpochInfo: () => ({
        send: async () => ({
          epoch: 1n,
          absoluteSlot: 100n,
          slotIndex: 0n,
          slotsInEpoch: 100n,
          blockHeight: 100n,
          transactionCount: 0n,
        }),
      }),
      getEpochSchedule: () => ({
        send: async () => ({
          slotsPerEpoch: 100n,
          firstNormalSlot: 0n,
          firstNormalEpoch: 0n,
          leaderScheduleSlotOffset: 0n,
          warmup: false,
        }),
      }),
      getVoteAccounts: () => ({
        send: async () => ({
          current: [
            // staked — should be included
            { nodePubkey: STAKED_NODE as Address, activatedStake: 1_000_000n, votePubkey: STAKED_NODE as Address, commission: 0, epochCredits: [], epochVoteAccount: true, lastVote: 99n, rootSlot: 98n },
            // zero stake — should be excluded
            { nodePubkey: UNSTAKED_NODE as Address, activatedStake: 0n, votePubkey: UNSTAKED_NODE as Address, commission: 0, epochCredits: [], epochVoteAccount: false, lastVote: 99n, rootSlot: 98n },
          ],
          delinquent: [
            // delinquent with stake — should NOT be included
            { nodePubkey: DELINQUENT_NODE as Address, activatedStake: 500_000n, votePubkey: DELINQUENT_NODE as Address, commission: 0, epochCredits: [], epochVoteAccount: true, lastVote: 50n, rootSlot: 49n },
          ],
        }),
      }),
    };

    const fakeProvider = {
      getLeaders: async () => ({ leaders: [], source: 'slotLeaders' as const }),
    };

    const abortController = new AbortController();
    const snapshotRef = new AtomicSnapshotRef(EMPTY_SNAPSHOT);

    await startLeaderCache({
      rpc: fakeRpc as any,
      provider: fakeProvider,
      fanoutSlots: 5,
      emit: () => {},
      signal: abortController.signal,
      getCurrentSlot: () => 100n,
      snapshotRef,
      stakedIdentities,
    });

    // After init: STAKED_NODE in set, DELINQUENT_NODE and UNSTAKED_NODE excluded.
    expect(stakedIdentities.has(STAKED_NODE)).toBe(true);
    expect(stakedIdentities.has(DELINQUENT_NODE)).toBe(false);
    expect(stakedIdentities.has(UNSTAKED_NODE)).toBe(false);
    expect(stakedIdentities.size).toBe(1);

    abortController.abort();
  });
});

// ---------------------------------------------------------------------------
// A3: rpc-error emitted on getSlotLeaders failure (F8)
// ---------------------------------------------------------------------------

describe('startLeaderCache rpc-error on provider failure', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits {type:error, error:{kind:rpc-error, source:leader-cache}} when provider rejects', async () => {
    vi.useFakeTimers();

    const emittedEvents: TpuEvent[] = [];
    const emit = (e: TpuEvent) => emittedEvents.push(e);

    const fakeRpc = {
      getClusterNodes: () => ({ send: async () => [] }),
      getEpochInfo: () => ({
        send: async () => ({
          epoch: 1n,
          absoluteSlot: 100n,
          slotIndex: 0n,
          slotsInEpoch: 100n,
          blockHeight: 100n,
          transactionCount: 0n,
        }),
      }),
      getEpochSchedule: () => ({
        send: async () => ({
          slotsPerEpoch: 100n,
          firstNormalSlot: 0n,
          firstNormalEpoch: 0n,
          leaderScheduleSlotOffset: 0n,
          warmup: false,
        }),
      }),
      getVoteAccounts: () => ({
        send: async () => ({ current: [], delinquent: [] }),
      }),
    };

    const failingProvider = {
      getLeaders: async (): Promise<never> => {
        throw new Error('RPC connection refused');
      },
    };

    const abortController = new AbortController();
    const snapshotRef = new AtomicSnapshotRef(EMPTY_SNAPSHOT);

    await startLeaderCache({
      rpc: fakeRpc as any,
      provider: failingProvider,
      fanoutSlots: 4,
      emit,
      signal: abortController.signal,
      getCurrentSlot: () => 100n,
      snapshotRef,
    });

    // Advance one tick to let the loop run and hit the error
    await vi.advanceTimersByTimeAsync(1_100);

    const rpcErrors = emittedEvents.filter(
      (e) =>
        e.type === 'error' &&
        e.error.kind === 'rpc-error' &&
        (e.error as { source: string }).source === 'leader-cache',
    );
    expect(rpcErrors.length).toBeGreaterThanOrEqual(1);

    abortController.abort();
  });
});

// ---------------------------------------------------------------------------
// A4: stale-snapshot emitted after persistent failures past 2×TICK_MS (F7)
// ---------------------------------------------------------------------------

describe('startLeaderCache stale-snapshot after persistent failures', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits stale-snapshot with numeric lastRefreshAgeMs >= 2000 after ~3s of failures', async () => {
    vi.useFakeTimers();

    const emittedEvents: TpuEvent[] = [];
    const emit = (e: TpuEvent) => emittedEvents.push(e);

    const fakeRpc = {
      getClusterNodes: () => ({ send: async () => [] }),
      getEpochInfo: () => ({
        send: async () => ({
          epoch: 1n,
          absoluteSlot: 100n,
          slotIndex: 0n,
          slotsInEpoch: 100n,
          blockHeight: 100n,
          transactionCount: 0n,
        }),
      }),
      getEpochSchedule: () => ({
        send: async () => ({
          slotsPerEpoch: 100n,
          firstNormalSlot: 0n,
          firstNormalEpoch: 0n,
          leaderScheduleSlotOffset: 0n,
          warmup: false,
        }),
      }),
      getVoteAccounts: () => ({
        send: async () => ({ current: [], delinquent: [] }),
      }),
    };

    const failingProvider = {
      getLeaders: async (): Promise<never> => {
        throw new Error('persistent RPC failure');
      },
    };

    const abortController = new AbortController();
    const snapshotRef = new AtomicSnapshotRef(EMPTY_SNAPSHOT);

    await startLeaderCache({
      rpc: fakeRpc as any,
      provider: failingProvider,
      fanoutSlots: 4,
      emit,
      signal: abortController.signal,
      getCurrentSlot: () => 100n,
      snapshotRef,
    });

    // Advance 3 ticks (3s) so lastRefreshAgeMs exceeds 2*TICK_MS=2000
    await vi.advanceTimersByTimeAsync(3_100);

    const staleEvents = emittedEvents.filter(
      (e): e is Extract<TpuEvent, { type: 'stale-snapshot' }> =>
        e.type === 'stale-snapshot',
    );
    expect(staleEvents.length).toBeGreaterThanOrEqual(1);
    // The first stale event should have lastRefreshAgeMs >= 2000
    const first = staleEvents[0]!;
    expect(typeof first.lastRefreshAgeMs).toBe('number');
    expect(first.lastRefreshAgeMs).toBeGreaterThanOrEqual(2000);

    abortController.abort();
  });
});

describe('startLeaderCache cluster refresh cadence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no cluster refresh at t=1s, refreshes at t=6min', async () => {
    vi.useFakeTimers();

    const clusterRefreshEvents: TpuEvent[] = [];
    const emit = (e: TpuEvent) => {
      if (e.type === 'cluster-refresh') clusterRefreshEvents.push(e);
    };

    let clusterCallCount = 0;
    const fakeRpc = {
      getClusterNodes: () => ({
        send: async () => {
          clusterCallCount++;
          return [{ pubkey: IDENTITY_A as Address, tpu: '1.2.3.4:8003', tpuQuic: '1.2.3.4:8009' }];
        },
      }),
      getEpochInfo: () => ({
        send: async () => ({
          epoch: 1n,
          absoluteSlot: 100n,
          slotIndex: 0n,
          slotsInEpoch: 100n,
          blockHeight: 100n,
          transactionCount: 0n,
        }),
      }),
      getEpochSchedule: () => ({
        send: async () => ({
          slotsPerEpoch: 100n,
          firstNormalSlot: 0n,
          firstNormalEpoch: 0n,
          leaderScheduleSlotOffset: 0n,
          warmup: false,
        }),
      }),
    };

    const fakeProvider = {
      getLeaders: async () => ({ leaders: [], source: 'slotLeaders' as const }),
    };

    const abortController = new AbortController();
    const snapshotRef = new AtomicSnapshotRef(EMPTY_SNAPSHOT);

    await startLeaderCache({
      rpc: fakeRpc as any,
      provider: fakeProvider,
      fanoutSlots: 5,
      emit,
      signal: abortController.signal,
      getCurrentSlot: () => 100n,
      snapshotRef,
    });

    // Initial cluster call happens in startLeaderCache
    const initialCount = clusterCallCount;

    // At 1s: no extra refresh
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clusterCallCount).toBe(initialCount);
    expect(clusterRefreshEvents).toHaveLength(0);

    // At 6 min (360s): should have refreshed
    await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);
    expect(clusterCallCount).toBeGreaterThan(initialCount);
    expect(clusterRefreshEvents.length).toBeGreaterThan(0);

    abortController.abort();
  });
});
