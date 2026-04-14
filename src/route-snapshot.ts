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
