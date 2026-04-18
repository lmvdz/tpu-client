import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import type { Slot } from '@solana/rpc-types';

import { resolveTpuQuicAddr } from './addr.js';
import type { EventEmitter } from './events.js';
import { AtomicSnapshotRef, makeSnapshot } from './route-snapshot.js';
import type { LeaderInfo } from './route-snapshot.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface LeaderDiscoveryProvider {
  getLeaders(slot: bigint, fanout: number): Promise<{ leaders: LeaderInfo[]; source: 'slotLeaders' | 'union' }>;
}

export interface DefaultProviderDeps {
  rpc: Rpc<SolanaRpcApi>;
  /** Cluster node map keyed by identity pubkey. Refreshed externally. */
  clusterNodes: ReadonlyMap<Address, { tpu?: string | null; tpuQuic?: string | null }>;
  /** Epoch schedule from getEpochSchedule(). */
  epochSchedule: {
    slotsPerEpoch: bigint;
    firstNormalSlot: bigint;
    firstNormalEpoch: bigint;
  };
  /** Current epoch info from getEpochInfo(). */
  currentEpoch: {
    epoch: bigint;
    absoluteSlot: bigint;
    slotIndex: bigint;
    slotsInEpoch: bigint;
  };
}

export interface LeaderCacheOptions {
  rpc: Rpc<SolanaRpcApi>;
  /** Override the discovery provider. Default: createDefaultProvider. */
  provider?: LeaderDiscoveryProvider;
  fanoutSlots: number;
  emit: EventEmitter;
  signal: AbortSignal;
  getCurrentSlot: () => bigint;
  snapshotRef: AtomicSnapshotRef;
  /**
   * Mutable Set owned by the caller (tpu-client). startLeaderCache will
   * populate it during init and refresh it alongside cluster nodes (~5 min).
   * Only `current` vote accounts with activatedStake > 0n are included;
   * delinquent validators are excluded because they are not leading slots.
   */
  stakedIdentities?: Set<Address>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the last slot (inclusive) of the epoch described by `epochInfo`.
 * Uses `absoluteSlot - slotIndex` to get the epoch's absolute start slot directly.
 */
function epochEndSlot(e: {
  absoluteSlot: bigint;
  slotIndex: bigint;
  slotsInEpoch: bigint;
}): bigint {
  const epochAbsStart = e.absoluteSlot - e.slotIndex;
  return epochAbsStart + e.slotsInEpoch - 1n;
}

/**
 * Compute the absolute start slot of a given epoch number, using the epoch schedule.
 * For normal epochs: firstNormalSlot + (epoch - firstNormalEpoch) * slotsPerEpoch.
 * For warm-up epochs (epoch < firstNormalEpoch): approximation via halving series.
 */
function epochStartSlot(
  epoch: bigint,
  schedule: { slotsPerEpoch: bigint; firstNormalSlot: bigint; firstNormalEpoch: bigint },
): bigint {
  if (epoch >= schedule.firstNormalEpoch) {
    return (
      schedule.firstNormalSlot +
      (epoch - schedule.firstNormalEpoch) * schedule.slotsPerEpoch
    );
  }
  // Warm-up: each warm-up epoch is slotsPerEpoch >> (firstNormalEpoch - epoch) slots.
  let slot = 0n;
  let e = 0n;
  while (e < epoch) {
    const warmEpochSlots =
      schedule.slotsPerEpoch >> (schedule.firstNormalEpoch - e);
    slot += warmEpochSlots > 0n ? warmEpochSlots : 1n;
    e++;
  }
  return slot;
}

/**
 * Build a slot-to-identity map from a leader schedule response.
 * `sched` maps identity -> slot indices relative to the epoch start.
 * `nextEpochStartSlot` is the absolute slot of the first slot in that epoch.
 */
function leadersFromSchedule(
  sched: Record<Address, readonly Slot[]>,
  nextEpochStartSlot: bigint,
  count: number,
): Address[] {
  const bySlot = new Map<bigint, Address>();
  for (const [identity, slots] of Object.entries(sched) as [Address, readonly Slot[]][]) {
    for (const relSlot of slots) {
      bySlot.set(nextEpochStartSlot + relSlot, identity);
    }
  }
  const out: Address[] = [];
  for (let i = 0n; i < BigInt(count); i++) {
    const id = bySlot.get(nextEpochStartSlot + i);
    if (id !== undefined) out.push(id);
  }
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // RT2-M1: remove abort listener when timeout fires naturally to avoid accumulation.
    const onAbort = () => { clearTimeout(id); resolve(); };
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Default LeaderDiscoveryProvider
// ---------------------------------------------------------------------------

export function createDefaultProvider(
  getDeps: () => DefaultProviderDeps,
): LeaderDiscoveryProvider {
  return {
    async getLeaders(startSlot: bigint, fanout: number): Promise<{ leaders: LeaderInfo[]; source: 'slotLeaders' | 'union' }> {
      const deps = getDeps();
      const { rpc, clusterNodes, currentEpoch, epochSchedule } = deps;
      const epochEnd = epochEndSlot(currentEpoch);

      // Clamp to within the current epoch.
      const lastWithinEpoch = startSlot + BigInt(fanout) - 1n < epochEnd
        ? startSlot + BigInt(fanout) - 1n
        : epochEnd;
      const primaryCount = Number(lastWithinEpoch - startSlot + 1n);

      const primary = await rpc
        .getSlotLeaders(startSlot as Slot, primaryCount)
        .send();
      const leaderAddrs: Address[] = primary.slice();
      let source: 'slotLeaders' | 'union' = 'slotLeaders';

      // Union with next-epoch schedule if we cross the boundary.
      if (primaryCount < fanout) {
        const nextEpochFirstSlot = epochEnd + 1n;
        try {
          const sched = await rpc
            .getLeaderSchedule(nextEpochFirstSlot as Slot)
            .send();
          if (sched !== null) {
            const need = fanout - primaryCount;
            const nextLeaders = leadersFromSchedule(
              sched as Record<Address, readonly Slot[]>,
              epochStartSlot(currentEpoch.epoch + 1n, epochSchedule),
              need,
            );
            leaderAddrs.push(...nextLeaders);
            source = 'union';
          }
        } catch {
          // Next epoch schedule not yet published — return clamped prefix.
        }
      }

      const leaders = leaderAddrs.map((identity) => {
        const contact = clusterNodes.get(identity);
        const tpuQuicAddr = contact != null ? resolveTpuQuicAddr(contact) : null;
        return { identity, tpuQuicAddr };
      });
      return { leaders, source };
    },
  };
}

// ---------------------------------------------------------------------------
// Refresh loop
// ---------------------------------------------------------------------------

export async function startLeaderCache(opts: LeaderCacheOptions): Promise<void> {
  const TICK_MS = 1_000;
  const CLUSTER_REFRESH_MS = 5 * 60_000;

  // Mutable cluster node map, written only by refreshClusterNodes().
  const clusterNodes = new Map<
    Address,
    { tpu: string | null; tpuQuic: string | null }
  >();

  async function refreshClusterNodes(): Promise<void> {
    const nodes = await opts.rpc.getClusterNodes().send();
    clusterNodes.clear();
    for (const n of nodes) {
      clusterNodes.set(n.pubkey, {
        tpu: n.tpu ?? null,
        tpuQuic: n.tpuQuic ?? null,
      });
    }
  }

  /**
   * Refresh staked identities from getVoteAccounts().
   * Only current (non-delinquent) validators with activatedStake > 0n qualify
   * for stake-weighted QoS — delinquent nodes are not leading slots.
   * F4: atomic swap via local Set, then swap in. Also validates activatedStake type.
   */
  async function refreshStakedIdentities(): Promise<void> {
    if (opts.stakedIdentities === undefined) return;
    const result = await opts.rpc.getVoteAccounts().send();
    // F4: build fresh set locally, then swap atomically (single synchronous block).
    const fresh = new Set<Address>();
    for (const va of result.current) {
      // F4: validate activatedStake is bigint before using it.
      if (typeof va.activatedStake !== 'bigint') {
        opts.emit({ type: 'error', error: { kind: 'rpc-error', source: 'stake-refresh', cause: `activatedStake is not bigint for ${String(va.nodePubkey)}` } });
        continue;
      }
      if (va.activatedStake > 0n) {
        fresh.add(va.nodePubkey as Address);
      }
    }
    // Atomic swap: clear and repopulate in one synchronous block.
    opts.stakedIdentities.clear();
    for (const pk of fresh) {
      opts.stakedIdentities.add(pk);
    }
  }

  // Initial fetches before entering the loop.
  await refreshClusterNodes();
  await refreshStakedIdentities();
  let epochInfo = await opts.rpc.getEpochInfo().send();
  // F3: validate slotsInEpoch on initial fetch.
  if (epochInfo.slotsInEpoch <= 0n) {
    throw new Error(`invalid slotsInEpoch: ${String(epochInfo.slotsInEpoch)}`);
  }
  let epochSchedule = await opts.rpc.getEpochSchedule().send();
  // F3: validate slotsPerEpoch on initial fetch.
  if (epochSchedule.slotsPerEpoch <= 0n) {
    throw new Error(`invalid slotsPerEpoch: ${String(epochSchedule.slotsPerEpoch)}`);
  }
  let lastClusterMs = Date.now();
  let generation = 0;
  // F7: track last successful refresh time for stale-snapshot detection.
  let lastSuccessfulRefreshMs = Date.now();

  const provider: LeaderDiscoveryProvider =
    opts.provider ??
    createDefaultProvider(() => ({
      rpc: opts.rpc,
      clusterNodes,
      epochSchedule: {
        slotsPerEpoch: epochSchedule.slotsPerEpoch,
        firstNormalSlot: epochSchedule.firstNormalSlot,
        firstNormalEpoch: epochSchedule.firstNormalEpoch,
      },
      currentEpoch: {
        epoch: epochInfo.epoch,
        absoluteSlot: epochInfo.absoluteSlot,
        slotIndex: epochInfo.slotIndex,
        slotsInEpoch: epochInfo.slotsInEpoch,
      },
    }));

  const loop = async (): Promise<void> => {
    while (!opts.signal.aborted) {
      try {
        const slot = opts.getCurrentSlot();

        // S4: skip tick until slot tracker has a real slot.
        if (slot === 0n) {
          await sleep(TICK_MS, opts.signal);
          continue;
        }

        // Cluster + stake refresh every 5 minutes.
        if (Date.now() - lastClusterMs > CLUSTER_REFRESH_MS) {
          await refreshClusterNodes();
          await refreshStakedIdentities();
          lastClusterMs = Date.now();
          opts.emit({ type: 'cluster-refresh', nodes: clusterNodes.size });
        }

        // F3: Epoch rollover detection — validate new epoch info before committing.
        if (slot >= epochInfo.absoluteSlot - epochInfo.slotIndex + epochInfo.slotsInEpoch) {
          const newEpochInfo = await opts.rpc.getEpochInfo().send();
          const newEpochSchedule = await opts.rpc.getEpochSchedule().send();
          if (newEpochInfo.slotsInEpoch <= 0n) {
            opts.emit({ type: 'error', error: { kind: 'rpc-error', source: 'epoch-info', cause: `invalid slotsInEpoch: ${String(newEpochInfo.slotsInEpoch)}` } });
            // Keep prior values, skip rollover.
          } else if (newEpochSchedule.slotsPerEpoch <= 0n) {
            opts.emit({ type: 'error', error: { kind: 'rpc-error', source: 'epoch-info', cause: `invalid slotsPerEpoch: ${String(newEpochSchedule.slotsPerEpoch)}` } });
            // Keep prior values, skip rollover.
          } else {
            epochInfo = newEpochInfo;
            epochSchedule = newEpochSchedule;
          }
        }

        // Rebuild the leader window and publish a new snapshot.
        const result = await provider.getLeaders(slot, opts.fanoutSlots);
        const snap = makeSnapshot(slot, result.leaders, ++generation);
        opts.snapshotRef.store(snap);
        lastSuccessfulRefreshMs = Date.now();
        opts.emit({
          type: 'leaders-refresh',
          startSlot: slot,
          count: result.leaders.length,
          source: result.source,
        });
      } catch (err) {
        // F8: emit rpc-error with proper source instead of repurposed slot-subscription.
        opts.emit({ type: 'error', error: { kind: 'rpc-error', source: 'leader-cache', cause: String(err) } });
        // F7: emit stale-snapshot if snapshot hasn't been updated in > 2*TICK_MS.
        const ageMs = Date.now() - lastSuccessfulRefreshMs;
        if (ageMs > 2 * TICK_MS) {
          opts.emit({ type: 'stale-snapshot', lastRefreshAgeMs: ageMs, reason: String(err) });
        }
      }

      await sleep(TICK_MS, opts.signal);
    }
  };

  void loop();
}
