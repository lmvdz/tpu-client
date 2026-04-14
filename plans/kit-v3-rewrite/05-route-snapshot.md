# 05 — route-snapshot.ts

STATUS: open
PRIORITY: p1
COMPLEXITY: mechanical
BLOCKED_BY: 01
TOUCHES: src/route-snapshot.ts

## Goal
Immutable leader-route container with atomic pointer swap so the hot-path send can read a consistent set of leaders without locking, while the refresh loop builds and publishes new snapshots off-path.

## Approach

```ts
import type { Address } from '@solana/kit';

export interface LeaderInfo {
  readonly identity: Address;
  readonly tpuQuicAddr: string | null;
  readonly stake?: bigint;
}

export interface RouteSnapshot {
  readonly asOfSlot: bigint;
  readonly leaders: readonly LeaderInfo[];
  readonly generation: number;
}

export function makeSnapshot(
  asOfSlot: bigint,
  leaders: readonly LeaderInfo[],
  generation: number,
): RouteSnapshot {
  const snap: RouteSnapshot = Object.freeze({
    asOfSlot,
    leaders: Object.freeze(leaders.slice()) as readonly LeaderInfo[],
    generation,
  });
  return snap;
}

/** Single-writer / multi-reader atomic reference. JS single-threaded runtime = pointer store is atomic. */
export class AtomicSnapshotRef {
  #current: RouteSnapshot;

  constructor(initial: RouteSnapshot) {
    this.#current = initial;
  }

  load(): RouteSnapshot {
    return this.#current;
  }

  store(next: RouteSnapshot): void {
    this.#current = next;
  }
}

export const EMPTY_SNAPSHOT: RouteSnapshot = makeSnapshot(0n, [], 0);
```

## Rules

- `LeaderInfo` is THE canonical shape — `leader-cache.ts` produces it, `quic-sender.ts` consumes it.
- Freeze the snapshot and the leaders array. Do not freeze individual `LeaderInfo` objects — they are already built with `readonly` props and freezing each entry wastes time on the hot path. (If freezing becomes cheap per benchmark, revisit.)
- `generation` is monotonic; used for debug and log correlation, not correctness.
- Node runs single-threaded on one event loop — pointer store/load is inherently atomic. No SharedArrayBuffer needed.

## Verify

```bash
npx tsc --noEmit
grep -q "Object.freeze" src/route-snapshot.ts
```

Unit tests (concern 14): round-trip snapshot, frozen-mutation throws in strict mode, generation ordering.
