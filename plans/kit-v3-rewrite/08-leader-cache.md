# 08 — leader-cache.ts

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 02, 03, 05 (VERIFY: `test -f src/events.ts -a -f src/addr.ts -a -f src/route-snapshot.ts`)
TOUCHES: src/leader-cache.ts

## Goal
Implement the default `LeaderDiscoveryProvider` that fetches upcoming leaders via `getSlotLeaders` + `getClusterNodes`, with epoch-boundary handling via `getLeaderSchedule(nextEpoch)` union. Drive the refresh loop that rebuilds `RouteSnapshot` and publishes it via `AtomicSnapshotRef`.

## Approach

Two exports:

### 1. `LeaderDiscoveryProvider` (public interface + default impl)

```ts
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import type { LeaderInfo } from './route-snapshot.js';
import { resolveTpuQuicAddr } from './addr.js';

export interface LeaderDiscoveryProvider {
  getLeaders(slot: bigint, fanout: number): Promise<LeaderInfo[]>;
}

export interface DefaultProviderDeps {
  rpc: Rpc<SolanaRpcApi>;
  /** Cluster node map keyed by identity pubkey. Refreshed externally. */
  clusterNodes: ReadonlyMap<Address, { tpu?: string | null; tpuQuic?: string | null }>;
  /** Epoch schedule (slotsPerEpoch, firstNormalSlot, etc.). Refreshed on epoch boundary. */
  epochSchedule: { slotsPerEpoch: bigint; firstNormalSlot: bigint };
  /** Current epoch info. */
  currentEpoch: { epoch: bigint; slotIndex: bigint; slotsInEpoch: bigint };
}

export function createDefaultProvider(getDeps: () => DefaultProviderDeps): LeaderDiscoveryProvider {
  return {
    async getLeaders(startSlot, fanout) {
      const deps = getDeps();
      const { rpc, clusterNodes, currentEpoch } = deps;
      const epochEnd = epochEndSlot(currentEpoch);

      const withinEpoch = clamp(startSlot + BigInt(fanout) - 1n, startSlot, epochEnd);
      const primaryCount = Number(withinEpoch - startSlot + 1n);

      const primary = await rpc.getSlotLeaders(startSlot, primaryCount).send();
      const leaders: Address[] = primary as Address[];

      // Union with next-epoch schedule if we cross the boundary.
      if (primaryCount < fanout) {
        const nextEpoch = currentEpoch.epoch + 1n;
        try {
          const sched = await rpc.getLeaderSchedule(epochEnd + 1n).send(); // may return null
          if (sched) {
            const nextStart = epochEnd + 1n;
            const need = fanout - primaryCount;
            const nextLeaders = leadersFromSchedule(sched, nextStart, need, nextEpoch, deps.epochSchedule);
            leaders.push(...nextLeaders);
          }
        } catch { /* next epoch schedule not yet published — return clamped prefix. */ }
      }

      return leaders.map((identity) => {
        const contact = clusterNodes.get(identity);
        const tpuQuicAddr = contact ? resolveTpuQuicAddr(contact) : null;
        return { identity, tpuQuicAddr };
      });
    },
  };
}
```

### 2. `LeaderCache` (drives the refresh loop, manages state)

```ts
import { AtomicSnapshotRef, makeSnapshot } from './route-snapshot.js';
import type { EventEmitter } from './events.js';

export interface LeaderCacheOptions {
  rpc: Rpc<SolanaRpcApi>;
  provider?: LeaderDiscoveryProvider; // default = createDefaultProvider internally
  fanoutSlots: number;
  emit: EventEmitter;
  signal: AbortSignal;
  getCurrentSlot: () => bigint;
  snapshotRef: AtomicSnapshotRef;
}

export async function startLeaderCache(opts: LeaderCacheOptions): Promise<void> {
  // 1. Initial cluster + epoch fetch BEFORE loop starts.
  const clusterNodes = new Map<Address, { tpu?: string | null; tpuQuic?: string | null }>();
  await refreshClusterNodes();
  let epochInfo = await opts.rpc.getEpochInfo().send();
  let epochSchedule = await opts.rpc.getEpochSchedule().send();

  const provider = opts.provider ?? createDefaultProvider(() => ({
    rpc: opts.rpc,
    clusterNodes,
    epochSchedule: { slotsPerEpoch: BigInt(epochSchedule.slotsPerEpoch), firstNormalSlot: BigInt(epochSchedule.firstNormalSlot) },
    currentEpoch: { epoch: BigInt(epochInfo.epoch), slotIndex: BigInt(epochInfo.slotIndex), slotsInEpoch: BigInt(epochInfo.slotsInEpoch) },
  }));

  let lastClusterMs = Date.now();
  let generation = 0;

  const TICK_MS = 1_000;
  const CLUSTER_REFRESH_MS = 5 * 60_000;

  const loop = async () => {
    while (!opts.signal.aborted) {
      try {
        const slot = opts.getCurrentSlot();

        // Cluster refresh (5 min).
        if (Date.now() - lastClusterMs > CLUSTER_REFRESH_MS) {
          await refreshClusterNodes();
          lastClusterMs = Date.now();
          opts.emit({ type: 'cluster-refresh', nodes: clusterNodes.size });
        }

        // Epoch-rollover refresh.
        if (BigInt(epochInfo.absoluteSlot) + BigInt(epochInfo.slotsInEpoch) - BigInt(epochInfo.slotIndex) <= slot) {
          epochInfo = await opts.rpc.getEpochInfo().send();
        }

        // Refresh leader window.
        const leaders = await provider.getLeaders(slot, opts.fanoutSlots);
        const snap = makeSnapshot(slot, leaders, ++generation);
        opts.snapshotRef.store(snap);
        opts.emit({
          type: 'leaders-refresh',
          startSlot: slot,
          count: leaders.length,
          source: leaders.length === opts.fanoutSlots ? 'slotLeaders' : 'union',
        });
      } catch (err) {
        // Loop survives transient failures; the next tick retries.
      }
      await sleep(TICK_MS, opts.signal);
    }
  };

  void loop();

  async function refreshClusterNodes() {
    const nodes = await opts.rpc.getClusterNodes().send();
    clusterNodes.clear();
    for (const n of nodes) {
      clusterNodes.set(n.pubkey as Address, { tpu: n.tpu, tpuQuic: (n as any).tpuQuic });
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
  });
}

function epochEndSlot(e: { epoch: bigint; slotIndex: bigint; slotsInEpoch: bigint }): bigint {
  const absStart = /* implementer: compute from epoch + epochSchedule.firstNormalSlot */ 0n;
  return absStart + e.slotsInEpoch - 1n;
}

function leadersFromSchedule(
  sched: Record<string, number[]>,
  startSlot: bigint,
  count: number,
  epoch: bigint,
  epochSchedule: { slotsPerEpoch: bigint; firstNormalSlot: bigint },
): Address[] {
  // sched maps identity -> array of relative slot indices within epoch
  // Build reverse lookup: slotIndex -> identity
  const epochStart = /* compute from epoch + schedule */ 0n;
  const bySlot = new Map<bigint, Address>();
  for (const [identity, slots] of Object.entries(sched)) {
    for (const s of slots) bySlot.set(epochStart + BigInt(s), identity as Address);
  }
  const out: Address[] = [];
  for (let i = 0n; i < BigInt(count); i++) {
    const slot = startSlot + i;
    const id = bySlot.get(slot);
    if (id) out.push(id);
  }
  return out;
}
```

## Decisions

- **Refresh cadence**: 1s tick is cheap, lets fanout window stay fresh as the slot advances.
- **Cluster refresh**: 5 min — matches Agave's `tpu_client`.
- **Epoch rollover**: recompute `getEpochInfo` when we cross the boundary; union-fetch next-epoch leader schedule as a best-effort backfill.
- **Failure mode**: the loop swallows errors per tick. If `getSlotLeaders` errors mid-epoch (rare but seen when RPC lags), the previous snapshot is retained. Document this.
- **`epochEndSlot` / `leadersFromSchedule`**: helpers intentionally left as stubs in the plan — implementer fills in using `epochSchedule.firstNormalSlot` + `slotsPerEpoch` math per [Solana epoch docs](https://docs.anza.xyz/runtime/sysvars#epochschedule).

## Open issues for implementer

- `rpc.getLeaderSchedule(slot)` — kit 3.x signature: check whether it takes an identifier slot or an epoch number. If there's an epoch-based variant, prefer it.
- `getClusterNodes()` result shape — `tpuQuic` field may or may not be camelCase in kit; verify at implementation and adapt.

## Verify

```bash
npx tsc --noEmit
grep -q "getLeaderSchedule" src/leader-cache.ts
grep -q "cluster-refresh" src/leader-cache.ts
```

Unit tests (concern 14): epoch-boundary union logic with mocked provider; cluster refresh cadence with fake timers; empty `getClusterNodes` → empty snapshot.
