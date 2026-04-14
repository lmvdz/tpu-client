# 09 — quic-pool.ts

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 02, 05 (VERIFY: `test -f src/errors.ts -a -f src/route-snapshot.ts`)
TOUCHES: src/quic-pool.ts

## Goal
Per-identity QUIC connection pool: LRU-capped, refcount-safe, with a per-connection stream semaphore for backpressure. The pool exposes `acquire` / `release` for send-path use and an eviction tick for idle/non-upcoming connections.

## Approach

```ts
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
}

export class QuicPool {
  readonly #entries = new Map<Address, PoolEntry>();
  readonly #opts: Required<Omit<QuicPoolOptions, 'poolCap' | 'emit' | 'signal' | 'getUpcomingIdentities'>>
    & Pick<QuicPoolOptions, 'emit' | 'signal' | 'getUpcomingIdentities'>
    & { poolCap: number };

  constructor(opts: QuicPoolOptions) {
    this.#opts = {
      openConn: opts.openConn,
      maxStreamsFor: opts.maxStreamsFor,
      poolCap: opts.poolCap ?? DEFAULT_POOL_CAP,
      emit: opts.emit,
      signal: opts.signal,
      getUpcomingIdentities: opts.getUpcomingIdentities,
    };
    this.#startEvictor();
    opts.signal.addEventListener('abort', () => { void this.#closeAll('aborted'); }, { once: true });
  }

  async acquire(identity: Address, addr: string): Promise<PoolEntry> {
    let entry = this.#entries.get(identity);
    if (entry && entry.state !== 'open') entry = undefined; // draining/closed — reopen
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
    const now = Date.now();
    const upcoming = this.#opts.getUpcomingIdentities();
    for (const entry of this.#entries.values()) {
      if (entry.state !== 'open' || entry.refcount > 0) continue;
      const idle = now - entry.lastUse;
      const notUpcoming = !upcoming.has(entry.identity);
      if (idle > IDLE_EVICT_MS || (notUpcoming && idle > 5_000)) {
        await this.#drainAndClose(entry, idle > IDLE_EVICT_MS ? 'idle' : 'not-upcoming');
      }
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
```

## Decisions

- **Key**: identity pubkey, NOT addr. Handles gossip-addr churn without spurious reconnects.
- **Refcount**: incremented in `acquire`, decremented in `release`. Eviction only targets `refcount===0`. The `drainAndClose` loop pauses if refcount somehow rose during draining (race guard; should never trigger in practice because map delete precedes).
- **Upcoming leaders**: aggressive eviction (5s idle) for identities NOT in the current upcoming set frees sockets when a validator drops out of the near-term window.
- **Semaphore**: `tryAcquire` is synchronous, non-blocking. `quic-sender` handles rejection → `BackpressureError`.
- **Cap**: 1024 default. If saturated with all-refcounted entries, we admit over-cap (soft cap) rather than block — backpressure is a send-time decision.
- **Abort**: pool cleans up all entries on signal abort.

## Verify

```bash
npx tsc --noEmit
```

Unit tests (concern 14): acquire/release refcount semantics; LRU eviction under cap; aggressive eviction for non-upcoming; semaphore tryAcquire saturation; signal abort closes all.
