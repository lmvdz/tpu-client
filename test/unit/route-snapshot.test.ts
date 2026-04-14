import { describe, it, expect } from 'vitest';
import {
  makeSnapshot,
  AtomicSnapshotRef,
  EMPTY_SNAPSHOT,
} from '../../src/route-snapshot.js';
import type { LeaderInfo } from '../../src/route-snapshot.js';

const leader: LeaderInfo = { identity: 'Addr1111111111111111111111111111111111111111' as any, tpuQuicAddr: '1.2.3.4:8009' };

describe('makeSnapshot', () => {
  it('freezes the snapshot object', () => {
    const snap = makeSnapshot(100n, [leader], 1);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('freezes the leaders array', () => {
    const snap = makeSnapshot(100n, [leader], 1);
    expect(Object.isFrozen(snap.leaders)).toBe(true);
  });

  it('mutation in strict mode throws on snapshot', () => {
    const snap = makeSnapshot(100n, [leader], 1);
    expect(() => {
      (snap as any).asOfSlot = 999n;
    }).toThrow();
  });

  it('mutation in strict mode throws on leaders array', () => {
    const snap = makeSnapshot(100n, [leader], 1);
    expect(() => {
      (snap.leaders as any).push(leader);
    }).toThrow();
  });
});

describe('AtomicSnapshotRef', () => {
  it('store/load round-trip', () => {
    const snap1 = makeSnapshot(1n, [], 1);
    const snap2 = makeSnapshot(2n, [leader], 2);
    const ref = new AtomicSnapshotRef(snap1);
    expect(ref.load()).toBe(snap1);
    ref.store(snap2);
    expect(ref.load()).toBe(snap2);
  });
});

describe('generation monotonicity', () => {
  it('generations increase when snapshots created in sequence', () => {
    const s1 = makeSnapshot(1n, [], 1);
    const s2 = makeSnapshot(2n, [], 2);
    const s3 = makeSnapshot(3n, [], 3);
    expect(s1.generation).toBeLessThan(s2.generation);
    expect(s2.generation).toBeLessThan(s3.generation);
  });
});

describe('EMPTY_SNAPSHOT', () => {
  it('has empty leaders array', () => {
    expect(EMPTY_SNAPSHOT.leaders.length).toBe(0);
  });
});
