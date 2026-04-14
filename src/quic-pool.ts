import type { Address } from '@solana/kit';
import type { EventEmitter } from './events.js';

const DEFAULT_POOL_CAP = 1024;
const IDLE_EVICT_MS = 30_000;

export interface QuicConnection {
  /** Opaque handle; actual creation lives in quic-sender.ts. */
  destroy(reason?: string): Promise<void>;
  /** Whether the underlying connection is still usable. */
  isOpen(): boolean;
}

export interface PoolEntry {
  readonly identity: Address;
  readonly addr: string;
  readonly conn: QuicConnection;
  readonly streamSlots: AsyncSemaphore;
  refcount: number;
  lastUse: number;
  state: 'open' | 'draining' | 'closed';
}

export interface OpenConnArgs {
  identity: Address;
  addr: string;
  maxStreams: number;
}

export interface QuicPoolOptions {
  /** Injected by quic-sender — the pool doesn't know how to build a QUICClient. */
  openConn: (args: OpenConnArgs) => Promise<QuicConnection>;
  maxStreamsFor: (identity: Address) => number;
  poolCap?: number;
  emit: EventEmitter;
  signal: AbortSignal;
  /** Read current upcoming leaders to drive aggressive eviction. */
  getUpcomingIdentities: () => ReadonlySet<Address>;
  /** Returns true if this identity is quarantined (e.g. cert-pin-mismatch). */
  isQuarantined?: (identity: Address) => boolean;
}

/** Internal resolved options (all fields present, defaults applied). */
interface ResolvedOpts {
  openConn: (args: OpenConnArgs) => Promise<QuicConnection>;
  maxStreamsFor: (identity: Address) => number;
  poolCap: number;
  emit: EventEmitter;
  signal: AbortSignal;
  getUpcomingIdentities: () => ReadonlySet<Address>;
  isQuarantined?: (identity: Address) => boolean;
}

export class QuicPool {
  readonly #entries = new Map<Address, PoolEntry>();
  readonly #opts: ResolvedOpts;
  #evictorRunning = false;

  constructor(opts: QuicPoolOptions) {
    this.#opts = {
      openConn: opts.openConn,
      maxStreamsFor: opts.maxStreamsFor,
      poolCap: opts.poolCap ?? DEFAULT_POOL_CAP,
      emit: opts.emit,
      signal: opts.signal,
      getUpcomingIdentities: opts.getUpcomingIdentities,
      ...(opts.isQuarantined !== undefined ? { isQuarantined: opts.isQuarantined } : {}),
    };
    this.#startEvictor();
    opts.signal.addEventListener('abort', () => { void this.#closeAll('aborted'); }, { once: true });
  }

  async acquire(identity: Address, addr: string): Promise<PoolEntry> {
    if (this.#opts.isQuarantined?.(identity)) {
      throw new Error('quarantined');
    }
    let entry = this.#entries.get(identity);
    if (entry && entry.state !== 'open') entry = undefined; // draining/closed — reopen
    // C4: stale addr — evict and reopen with new addr.
    if (entry && entry.addr !== addr) {
      await this.#drainAndClose(entry, 'addr-changed');
      entry = undefined;
    }
    if (!entry) {
      await this.#ensureCapacity();
      const conn = await this.#opts.openConn({
        identity,
        addr,
        maxStreams: this.#opts.maxStreamsFor(identity),
      });
      entry = {
        identity,
        addr,
        conn,
        streamSlots: new AsyncSemaphore(this.#opts.maxStreamsFor(identity)),
        refcount: 0,
        lastUse: Date.now(),
        state: 'open',
      };
      this.#entries.set(identity, entry);
      this.#opts.emit({ type: 'conn-open', identity });
    }
    entry.refcount++;
    entry.lastUse = Date.now();
    return entry;
  }

  release(entry: PoolEntry): void {
    entry.refcount--;
    entry.lastUse = Date.now();
  }

  async #ensureCapacity(): Promise<void> {
    if (this.#entries.size < this.#opts.poolCap) return;
    // LRU evict any refcount=0 open entry.
    const candidates = [...this.#entries.values()]
      .filter((e) => e.state === 'open' && e.refcount === 0)
      .sort((a, b) => a.lastUse - b.lastUse);
    const victim = candidates[0];
    if (!victim) return; // everyone is busy; admit anyway (soft cap)
    await this.#drainAndClose(victim, 'lru');
  }

  #startEvictor(): void {
    const id = setInterval(() => { void this.#evictTick(); }, 1_000);
    this.#opts.signal.addEventListener('abort', () => clearInterval(id), { once: true });
  }

  async #evictTick(): Promise<void> {
    if (this.#evictorRunning) return;
    this.#evictorRunning = true;
    try {
      const now = Date.now();
      const upcoming = this.#opts.getUpcomingIdentities();
      // Snapshot entries to avoid mutation-during-iteration issues.
      const snapshot = [...this.#entries.values()];
      for (const entry of snapshot) {
        if (entry.state !== 'open' || entry.refcount > 0) continue;
        const idle = now - entry.lastUse;
        const notUpcoming = !upcoming.has(entry.identity);
        if (idle > IDLE_EVICT_MS || (notUpcoming && idle > 5_000)) {
          await this.#drainAndClose(entry, idle > IDLE_EVICT_MS ? 'idle' : 'not-upcoming');
        }
      }
    } finally {
      this.#evictorRunning = false;
    }
  }

  async #drainAndClose(entry: PoolEntry, reason: string): Promise<void> {
    entry.state = 'draining';
    this.#entries.delete(entry.identity); // prevent new acquires from finding it
    this.#opts.emit({ type: 'conn-evict', identity: entry.identity, reason });
    // refcount is already 0 at call sites above; defensive wait for in-flight completion.
    while (entry.refcount > 0) await new Promise((r) => setTimeout(r, 25));
    await entry.conn.destroy(reason).catch(() => {});
    entry.state = 'closed';
    this.#opts.emit({ type: 'conn-close', identity: entry.identity, reason });
  }

  async #closeAll(reason: string): Promise<void> {
    const all = [...this.#entries.values()];
    await Promise.allSettled(all.map((e) => this.#drainAndClose(e, reason)));
  }
}

/** Minimal async semaphore; tryAcquire returns false immediately if saturated. */
export class AsyncSemaphore {
  #available: number;
  constructor(initial: number) { this.#available = initial; }
  tryAcquire(): boolean {
    if (this.#available <= 0) return false;
    this.#available--;
    return true;
  }
  release(): void { this.#available++; }
  get available(): number { return this.#available; }
}
