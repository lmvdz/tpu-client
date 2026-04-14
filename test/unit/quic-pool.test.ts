import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QuicPool, AsyncSemaphore } from '../../src/quic-pool.js';
import type { QuicConnection } from '../../src/quic-pool.js';
import type { TpuEvent } from '../../src/events.js';
import type { Address } from '@solana/kit';

function makeAddr(label: string): Address {
  return `${label}${'1'.repeat(44 - label.length)}` as Address;
}

const ID_A = makeAddr('A');
const ID_B = makeAddr('B');
const ID_C = makeAddr('C');

function makeFakeConn(): QuicConnection {
  return {
    destroy: vi.fn(async () => {}),
    isOpen: vi.fn(() => true),
  };
}

function makePool(opts: {
  poolCap?: number;
  getUpcomingIdentities?: () => ReadonlySet<Address>;
  signal?: AbortSignal;
  emit?: (e: TpuEvent) => void;
}) {
  const ac = new AbortController();
  const signal = opts.signal ?? ac.signal;
  const emit = opts.emit ?? (() => {});
  const openConn = vi.fn(async () => makeFakeConn());
  const pool = new QuicPool({
    openConn,
    maxStreamsFor: () => 8,
    poolCap: opts.poolCap ?? 1024,
    emit,
    signal,
    getUpcomingIdentities: opts.getUpcomingIdentities ?? (() => new Set()),
  });
  return { pool, openConn, ac };
}

describe('QuicPool refcount', () => {
  afterEach(() => vi.useRealTimers());

  it('acquire same identity twice → same entry, refcount=2', async () => {
    const { pool, ac } = makePool({});
    const e1 = await pool.acquire(ID_A, '1.2.3.4:8009');
    const e2 = await pool.acquire(ID_A, '1.2.3.4:8009');
    expect(e1).toBe(e2);
    expect(e1.refcount).toBe(2);
    ac.abort();
  });

  it('release decrements refcount', async () => {
    const { pool, ac } = makePool({});
    const e1 = await pool.acquire(ID_A, '1.2.3.4:8009');
    await pool.acquire(ID_A, '1.2.3.4:8009');
    pool.release(e1);
    expect(e1.refcount).toBe(1);
    ac.abort();
  });
});

describe('QuicPool LRU eviction', () => {
  afterEach(() => vi.useRealTimers());

  it('pool cap=2: acquire A+release, B+release, C → A evicted', async () => {
    const events: TpuEvent[] = [];
    const { pool, ac } = makePool({
      poolCap: 2,
      emit: (e) => events.push(e),
    });

    const eA = await pool.acquire(ID_A, '1.0.0.1:8009');
    pool.release(eA);

    const eB = await pool.acquire(ID_B, '1.0.0.2:8009');
    pool.release(eB);

    // Acquiring C should trigger LRU eviction of A (oldest lastUse)
    const eC = await pool.acquire(ID_C, '1.0.0.3:8009');
    expect(eC.identity).toBe(ID_C);

    const evictions = events.filter((e) => e.type === 'conn-evict') as any[];
    expect(evictions.some((e) => e.identity === ID_A)).toBe(true);

    ac.abort();
  });
});

describe('QuicPool evictor', () => {
  afterEach(() => vi.useRealTimers());

  it('idle > 30s and not upcoming → evicted', async () => {
    vi.useFakeTimers();
    const events: TpuEvent[] = [];
    const { pool, ac } = makePool({
      emit: (e) => events.push(e),
      getUpcomingIdentities: () => new Set(),
    });

    const entry = await pool.acquire(ID_A, '1.0.0.1:8009');
    pool.release(entry);

    // Advance 31 seconds for the evictor tick to fire
    await vi.advanceTimersByTimeAsync(31_000);

    const evictions = events.filter((e) => e.type === 'conn-evict') as any[];
    expect(evictions.some((e) => e.identity === ID_A)).toBe(true);

    ac.abort();
  });

  it('idle > 5s and not upcoming → evicted', async () => {
    vi.useFakeTimers();
    const events: TpuEvent[] = [];
    const { pool, ac } = makePool({
      emit: (e) => events.push(e),
      getUpcomingIdentities: () => new Set(),
    });

    const entry = await pool.acquire(ID_A, '1.0.0.1:8009');
    pool.release(entry);

    // Advance 6 seconds — idle > 5s, notUpcoming → evict
    await vi.advanceTimersByTimeAsync(6_000);

    const evictions = events.filter((e) => e.type === 'conn-evict') as any[];
    expect(evictions.some((e) => e.identity === ID_A)).toBe(true);

    ac.abort();
  });
});

describe('QuicPool abort signal', () => {
  it('abort closes all entries', async () => {
    const events: TpuEvent[] = [];
    const ac = new AbortController();
    const { pool } = makePool({ signal: ac.signal, emit: (e) => events.push(e) });

    const eA = await pool.acquire(ID_A, '1.0.0.1:8009');
    pool.release(eA);
    const eB = await pool.acquire(ID_B, '1.0.0.2:8009');
    pool.release(eB);

    ac.abort();
    await new Promise((r) => setTimeout(r, 50));

    const closes = events.filter((e) => e.type === 'conn-close');
    expect(closes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('AsyncSemaphore', () => {
  it('tryAcquire returns false after capacity exhausted', () => {
    const sem = new AsyncSemaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
  });

  it('release restores capacity', () => {
    const sem = new AsyncSemaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
  });
});
