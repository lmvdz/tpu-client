import type { Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi, Signature } from '@solana/kit';
import type { Address } from '@solana/kit';
import { getBase58Decoder } from '@solana/kit';
import { buildIdentity } from './identity.js';
import { createSlotTracker } from './slot-tracker.js';
import { startLeaderCache } from './leader-cache.js';
import { QuicPool } from './quic-pool.js';
import { openTpuQuicConn, sendOnce, type PinMode } from './quic-sender.js';
import { AtomicSnapshotRef, EMPTY_SNAPSHOT } from './route-snapshot.js';
import { noopEmitter, type EventEmitter, type LeaderAttempt } from './events.js';
import { TpuSendError } from './errors.js';
import type { TpuLeaderError } from './errors.js';
import type { TpuEvent } from './events.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CreateTpuClientOptions {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  identity?: CryptoKeyPair;
  fanoutSlots?: number;
  maxStreamsPerConn?: { staked: number; unstaked: number };
  poolCap?: number;
  onEvent?: EventEmitter;
  signal?: AbortSignal;
  /**
   * Server cert-pin mode. Default `'observe'` — accept connections but emit a
   * `cert-pin-mismatch` TpuEvent when the server cert SPKI doesn't match the
   * gossip identity. Use `'strict'` only if you know your target fleet presents
   * identity-signed certs (pure Agave, no load balancers). Empirically, ~100%
   * of Frankendancer nodes and a meaningful fraction of Agave nodes present
   * certs whose SPKI does NOT equal the validator identity as of April 2026.
   */
  pinMode?: PinMode;
  /**
   * F14: tunable transport timeouts. Defaults: connectMs=5000, writeMs=2000, destroyMs=2000.
   */
  timeouts?: { connectMs?: number; writeMs?: number; destroyMs?: number };
}

// ---------------------------------------------------------------------------
// F13: stats shape
// ---------------------------------------------------------------------------

export interface TpuClientStats {
  poolSize: number;
  inFlightSends: number;
  upcomingLeaders: number;
  quarantined: number;
  lastSnapshotAgeMs: number;
  lastSlotAgeMs: number;
  stakedKnown: number;
}

export interface TpuClient {
  readonly ready: Promise<void>;
  sendRawTransaction(
    tx: Uint8Array,
    opts?: { signal?: AbortSignal; fanoutSlots?: number },
  ): Promise<SendResult>;
  close(opts?: { timeoutMs?: number }): Promise<void>;
  /** F13: synchronous snapshot of operational stats. */
  getStats(): TpuClientStats;
}

export interface SendResult {
  signature: Signature;
  attempts: LeaderAttempt[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FANOUT = 4;
const DEFAULT_MAX_STREAMS = { staked: 128, unstaked: 8 };
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

// Hoist decoder to module scope (RT3-S6)
const base58Decoder = getBase58Decoder();

// ---------------------------------------------------------------------------
// F5: input validation helpers
// ---------------------------------------------------------------------------

function validateCreateOptions(opts: CreateTpuClientOptions): void {
  if (opts.fanoutSlots !== undefined) {
    if (
      !Number.isInteger(opts.fanoutSlots) ||
      opts.fanoutSlots < 1 ||
      opts.fanoutSlots > 64
    ) {
      throw new TypeError(
        `fanoutSlots must be an integer in [1, 64]; got ${String(opts.fanoutSlots)}`,
      );
    }
  }
  if (opts.poolCap !== undefined) {
    if (!Number.isInteger(opts.poolCap) || opts.poolCap < 1) {
      throw new TypeError(
        `poolCap must be an integer >= 1; got ${String(opts.poolCap)}`,
      );
    }
  }
  if (opts.maxStreamsPerConn !== undefined) {
    if (
      !Number.isInteger(opts.maxStreamsPerConn.staked) ||
      opts.maxStreamsPerConn.staked < 1
    ) {
      throw new TypeError(
        `maxStreamsPerConn.staked must be an integer >= 1; got ${String(opts.maxStreamsPerConn.staked)}`,
      );
    }
    if (
      !Number.isInteger(opts.maxStreamsPerConn.unstaked) ||
      opts.maxStreamsPerConn.unstaked < 1
    ) {
      throw new TypeError(
        `maxStreamsPerConn.unstaked must be an integer >= 1; got ${String(opts.maxStreamsPerConn.unstaked)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createTpuClient(opts: CreateTpuClientOptions): Promise<TpuClient> {
  // F5: validate options before doing anything.
  validateCreateOptions(opts);

  const userEmit = opts.onEvent ?? noopEmitter;

  // F11: quarantine with per-identity TTL expiry (Map<Address, expiryMs>).
  const quarantine = new Map<Address, number>();
  const QUARANTINE_TTL_MS = 60_000;
  const pinMode = opts.pinMode ?? 'observe';

  const emit: EventEmitter = (e: TpuEvent): void => {
    if (e.type === 'cert-pin-mismatch' && pinMode === 'strict') {
      quarantine.set(e.identity, Date.now() + QUARANTINE_TTL_MS);
    }
    if (e.type === 'cluster-refresh') quarantine.clear();
    // F11: prune expired quarantine entries on every event (cheap).
    const now = Date.now();
    for (const [id, expiry] of quarantine) {
      if (expiry <= now) quarantine.delete(id);
    }
    userEmit(e);
  };

  // Wire external signal into our internal AbortController.
  const internalAbort = new AbortController();
  const abortAll = (): void => { internalAbort.abort(); };
  if (opts.signal !== undefined) {
    opts.signal.addEventListener('abort', abortAll, { once: true });
  }
  const signal = internalAbort.signal;

  // Partial-init cleanup: disposers are pushed in order, unwound in reverse.
  const disposers: Array<() => Promise<void> | void> = [];
  const dispose = async (): Promise<void> => {
    for (const d of disposers.reverse()) {
      try { await d(); } catch { /* suppress — best-effort cleanup */ }
    }
  };

  try {
    // 1. Identity / TLS cert.
    const tpuIdentity = await buildIdentity(opts.identity);
    if (tpuIdentity.ephemeral) {
      // F9: emit event instead of console.warn.
      emit({ type: 'ephemeral-identity' });
    }

    // 2. Slot tracker (subscribes over rpcSubscriptions).
    const slotTracker = await createSlotTracker({
      rpc: opts.rpc,
      rpcSubscriptions: opts.rpcSubscriptions,
      emit,
      signal,
    });

    // 3. Atomic snapshot reference — starts empty.
    const snapshotRef = new AtomicSnapshotRef(EMPTY_SNAPSHOT);

    // 3b. Staked identities set — populated by leader cache via getVoteAccounts().
    const stakedIdentities = new Set<Address>();

    // 4. Leader cache refresh loop.
    await startLeaderCache({
      rpc: opts.rpc,
      fanoutSlots: opts.fanoutSlots ?? DEFAULT_FANOUT,
      emit,
      signal,
      getCurrentSlot: (): bigint => {
        try { return slotTracker.estimate(); } catch { return 0n; }
      },
      snapshotRef,
      stakedIdentities,
    });

    // 5a/5b. Build ready promise and await it.
    const readyDeferred = (async () => {
      await slotTracker.ready;
      await waitForSnapshot(snapshotRef, signal);
    })();
    await readyDeferred;

    // 6. Signal readiness.
    emit({ type: 'ready' });

    // 7. QUIC connection pool.
    const maxStreams = opts.maxStreamsPerConn ?? DEFAULT_MAX_STREAMS;
    // F14: plumb tunable timeouts into openTpuQuicConn via OpenArgs.
    const timeouts = opts.timeouts;

    const poolOptsBase = {
      openConn: (args: { identity: Address; addr: string; maxStreams: number }) =>
        openTpuQuicConn({
          identity: args.identity,
          addr: args.addr,
          maxStreams: args.maxStreams,
          tpuIdentity,
          emit,
          pinMode,
          ...(timeouts !== undefined ? { timeouts } : {}),
        }),
      maxStreamsFor: (identity: Address): number =>
        stakedIdentities.has(identity) ? maxStreams.staked : maxStreams.unstaked,
      emit,
      signal,
      getUpcomingIdentities: (): ReadonlySet<Address> =>
        new Set(snapshotRef.load().leaders.map((l) => l.identity)),
      // F11: check per-identity TTL expiry.
      isQuarantined: (identity: Address): boolean => {
        const expiry = quarantine.get(identity);
        return expiry !== undefined && expiry > Date.now();
      },
    };

    const pool = opts.poolCap !== undefined
      ? new QuicPool({ ...poolOptsBase, poolCap: opts.poolCap })
      : new QuicPool(poolOptsBase);

    // ---------------------------------------------------------------------------
    // In-flight tracking for graceful close().
    // ---------------------------------------------------------------------------
    const inFlight = new Set<Promise<unknown>>();
    let closing = false;

    // ---------------------------------------------------------------------------
    // TpuClient implementation
    // ---------------------------------------------------------------------------
    const client: TpuClient = {
      ready: readyDeferred,

      // F13: synchronous stats snapshot.
      getStats(): TpuClientStats {
        const snap = snapshotRef.load();
        return {
          poolSize: pool.size,
          inFlightSends: inFlight.size,
          upcomingLeaders: snap.leaders.length,
          quarantined: quarantine.size,
          lastSnapshotAgeMs: snap.asOfSlot === 0n ? Infinity : 0,
          lastSlotAgeMs: slotTracker.isFresh() ? 0 : Infinity,
          stakedKnown: stakedIdentities.size,
        };
      },

      async sendRawTransaction(tx, sendOpts): Promise<SendResult> {
        if (closing || signal.aborted) {
          throw new TpuSendError({ kind: 'aborted' });
        }

        // RT3-S6 + F1: validate tx bytes before doing anything async.
        if (tx.length < 65) {
          throw new TpuSendError({ kind: 'invalid-tx', reason: `tx too short: ${tx.length} bytes` });
        }
        // F1: 0-sig transaction guard.
        if ((tx[0] as number) === 0) {
          throw new TpuSendError({ kind: 'invalid-tx', reason: 'transaction has zero signatures' });
        }
        if ((tx[0] as number) >= 0x80) {
          throw new TpuSendError({ kind: 'invalid-tx', reason: '>=128 signatures not supported' });
        }

        // RT2-C1: Register a sentinel promise IMMEDIATELY in inFlight.
        let sentinelResolve!: (v: SendResult) => void;
        let sentinelReject!: (e: unknown) => void;
        const sentinelPromise = new Promise<SendResult>((res, rej) => {
          sentinelResolve = res;
          sentinelReject = rej;
        });
        inFlight.add(sentinelPromise);

        try {
          await readyDeferred;

          const sig = computeSignature(tx);
          const snap = snapshotRef.load();
          const fanout = sendOpts?.fanoutSlots ?? opts.fanoutSlots ?? DEFAULT_FANOUT;
          const leaders = snap.leaders.slice(0, fanout);

          if (leaders.length === 0) {
            throw new TpuSendError({ kind: 'no-leaders' });
          }

          const sendSignal = sendOpts?.signal ?? signal;

          // F6: pre-size attempts array and assign by index to preserve order.
          const attempts = new Array<LeaderAttempt>(leaders.length);

          const promises = leaders.map((leader, i) => async (): Promise<void> => {
            if (leader.tpuQuicAddr === null) {
              attempts[i] = {
                identity: leader.identity,
                tpuQuicAddr: '',
                ok: false,
                error: { kind: 'no-tpu-addr', identity: leader.identity },
              };
              return;
            }

            let entry;
            try {
              entry = await pool.acquire(leader.identity, leader.tpuQuicAddr);
            } catch (err) {
              const isQuarantinedErr = err instanceof Error && err.message === 'quarantined';
              attempts[i] = {
                identity: leader.identity,
                tpuQuicAddr: leader.tpuQuicAddr,
                ok: false,
                error: isQuarantinedErr
                  ? { kind: 'quarantined', identity: leader.identity }
                  : { kind: 'connect-timeout', identity: leader.identity },
              };
              return;
            }

            try {
              const result = await sendOnce(entry, tx, sendSignal);
              if ('rttMs' in result) {
                attempts[i] = {
                  identity: leader.identity,
                  tpuQuicAddr: leader.tpuQuicAddr,
                  ok: true,
                  rttMs: result.rttMs,
                };
              } else {
                attempts[i] = {
                  identity: leader.identity,
                  tpuQuicAddr: leader.tpuQuicAddr,
                  ok: false,
                  error: result as TpuLeaderError,
                };
              }
            } finally {
              pool.release(entry);
            }
          });

          await Promise.all(promises.map((fn) => fn()));

          emit({ type: 'send', signature: sig, attempts });

          if (!attempts.some((a) => a.ok)) {
            throw new TpuSendError(
              { kind: 'all-failed', attempts: attempts.length },
              `all ${attempts.length} leader attempt(s) failed`,
            );
          }

          const result: SendResult = { signature: sig, attempts };
          sentinelResolve(result);
          return result;
        } catch (err) {
          sentinelReject(err);
          throw err;
        } finally {
          inFlight.delete(sentinelPromise);
        }
      },

      async close(closeOpts?: { timeoutMs?: number }): Promise<void> {
        if (closing) return;
        closing = true;
        const timeoutMs = closeOpts?.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
        const drainPromise = Promise.allSettled([...inFlight]);
        const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
        await Promise.race([drainPromise, timeoutPromise]);
        abortAll();
        await dispose();
      },
    };

    return client;
  } catch (err) {
    await dispose();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForSnapshot(ref: AtomicSnapshotRef, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!signal.aborted) {
    if (ref.load().leaders.length > 0) return;
    if (Date.now() >= deadline) return;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

function computeSignature(tx: Uint8Array): Signature {
  const sigBytes = tx.subarray(1, 65);
  return base58Decoder.decode(sigBytes) as unknown as Signature;
}
