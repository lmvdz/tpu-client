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
}

export interface TpuClient {
  readonly ready: Promise<void>;
  sendRawTransaction(
    tx: Uint8Array,
    opts?: { signal?: AbortSignal; fanoutSlots?: number },
  ): Promise<SendResult>;
  close(): Promise<void>;
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createTpuClient(opts: CreateTpuClientOptions): Promise<TpuClient> {
  const userEmit = opts.onEvent ?? noopEmitter;

  // Quarantine: track identities whose STRICT pin check rejected; clear on
  // cluster-refresh (close enough to epoch rotation cadence). In 'observe' mode
  // (default) the event fires informatively and does NOT quarantine because the
  // connection succeeded — quarantining observe-mode mismatches would lock the
  // client out of ~20%+ of real mainnet leaders.
  const quarantine = new Set<Address>();
  const pinMode = opts.pinMode ?? 'observe';
  const emit: EventEmitter = (e: TpuEvent): void => {
    if (e.type === 'cert-pin-mismatch' && pinMode === 'strict') {
      quarantine.add(e.identity);
    }
    if (e.type === 'cluster-refresh') quarantine.clear();
    userEmit(e);
  };

  // Wire external signal into our internal AbortController.
  // When the external signal fires, we abort internally; our signal is what
  // all child components observe.
  const internalAbort = new AbortController();
  const abortAll = (): void => { internalAbort.abort(); };
  if (opts.signal !== undefined) {
    opts.signal.addEventListener('abort', abortAll, { once: true });
  }
  const signal = internalAbort.signal;

  // Partial-init cleanup: disposers are pushed in order, unwound in reverse.
  // We do NOT use AsyncDisposableStack (ES2024 — target is ES2023).
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
      console.warn(
        '[tpu-client] No identity keypair supplied — using ephemeral Ed25519 key. ' +
          'This identity is unstaked and will be first-dropped by validators under load.',
      );
    }

    // 2. Slot tracker (subscribes over rpcSubscriptions).
    const slotTracker = await createSlotTracker({
      rpc: opts.rpc,
      rpcSubscriptions: opts.rpcSubscriptions,
      emit,
      signal,
    });
    // Tracker teardown is bound to signal; no explicit disposer needed beyond the abort.

    // 3. Atomic snapshot reference — starts empty.
    const snapshotRef = new AtomicSnapshotRef(EMPTY_SNAPSHOT);

    // 3b. Staked identities set — populated by leader cache via getVoteAccounts().
    // Declared here so it's available to both startLeaderCache and the QuicPool
    // maxStreamsFor closure below.
    const stakedIdentities = new Set<Address>();

    // 4. Leader cache refresh loop — fires immediately then every ~1s.
    // startLeaderCache does initial RPC fetches (getClusterNodes, getEpochInfo,
    // getEpochSchedule, getVoteAccounts) synchronously before returning, so
    // after this await the first snapshot and staked set may already be populated.
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

    // 5a/5b. Build ready promise and await it (init still blocks; client.ready exposes same promise).
    const readyDeferred = (async () => {
      await slotTracker.ready;
      await waitForSnapshot(snapshotRef, signal);
    })();
    await readyDeferred;

    // 6. Signal readiness.
    emit({ type: 'ready' });

    // 7. QUIC connection pool.
    // stakedIdentities is declared at step 3b and populated by startLeaderCache.
    const maxStreams = opts.maxStreamsPerConn ?? DEFAULT_MAX_STREAMS;

    // Build pool options without the optional poolCap first, then conditionally
    // add it — exactOptionalPropertyTypes requires absence rather than undefined.
    const poolOptsBase = {
      openConn: (args: { identity: Address; addr: string; maxStreams: number }) =>
        openTpuQuicConn({
          identity: args.identity,
          addr: args.addr,
          maxStreams: args.maxStreams,
          tpuIdentity,
          emit,
          pinMode,
        }),
      maxStreamsFor: (identity: Address): number =>
        stakedIdentities.has(identity) ? maxStreams.staked : maxStreams.unstaked,
      emit,
      signal,
      getUpcomingIdentities: (): ReadonlySet<Address> =>
        new Set(snapshotRef.load().leaders.map((l) => l.identity)),
      isQuarantined: (identity: Address): boolean => quarantine.has(identity),
    };

    const pool = opts.poolCap !== undefined
      ? new QuicPool({ ...poolOptsBase, poolCap: opts.poolCap })
      : new QuicPool(poolOptsBase);
    // Pool teardown is bound to signal via its constructor listener.

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

      async sendRawTransaction(tx, sendOpts): Promise<SendResult> {
        await readyDeferred; // belt-and-suspenders per DESIGN.md §Startup
        if (closing || signal.aborted) {
          throw new TpuSendError({ kind: 'aborted' });
        }

        // S7: validate tx length before attempting send.
        if (tx.length < 65) {
          throw new TpuSendError({ kind: 'all-failed', attempts: 0 }, `tx too short: ${tx.length} bytes`);
        }

        const sig = computeSignature(tx);
        const snap = snapshotRef.load();
        const fanout = sendOpts?.fanoutSlots ?? opts.fanoutSlots ?? DEFAULT_FANOUT;
        const leaders = snap.leaders.slice(0, fanout);

        if (leaders.length === 0) {
          throw new TpuSendError({ kind: 'no-leaders' });
        }

        const sendSignal = sendOpts?.signal ?? signal;
        const attempts: LeaderAttempt[] = [];

        // Fan-out: attempt all leaders in parallel.
        const promises = leaders.map(async (leader): Promise<void> => {
          if (leader.tpuQuicAddr === null) {
            const attempt: LeaderAttempt = {
              identity: leader.identity,
              tpuQuicAddr: '',
              ok: false,
              error: { kind: 'no-tpu-addr', identity: leader.identity },
            };
            attempts.push(attempt);
            return;
          }

          let entry;
          try {
            entry = await pool.acquire(leader.identity, leader.tpuQuicAddr);
          } catch (err) {
            const isQuarantinedErr = err instanceof Error && err.message === 'quarantined';
            const attempt: LeaderAttempt = {
              identity: leader.identity,
              tpuQuicAddr: leader.tpuQuicAddr,
              ok: false,
              error: isQuarantinedErr
                ? { kind: 'quarantined', identity: leader.identity }
                : { kind: 'connect-timeout', identity: leader.identity },
            };
            attempts.push(attempt);
            return;
          }

          try {
            const result = await sendOnce(entry, tx, sendSignal);
            if ('rttMs' in result) {
              // Success path — rttMs present, no error field.
              const attempt: LeaderAttempt = {
                identity: leader.identity,
                tpuQuicAddr: leader.tpuQuicAddr,
                ok: true,
                rttMs: result.rttMs,
              };
              attempts.push(attempt);
            } else {
              // Failure path — result is a TpuError; no rttMs field.
              const attempt: LeaderAttempt = {
                identity: leader.identity,
                tpuQuicAddr: leader.tpuQuicAddr,
                ok: false,
                error: result,
              };
              attempts.push(attempt);
            }
          } finally {
            pool.release(entry);
          }
        });

        const batchPromise = Promise.all(promises);
        inFlight.add(batchPromise);
        try {
          await batchPromise;
        } finally {
          inFlight.delete(batchPromise);
        }

        emit({ type: 'send', signature: sig, attempts });

        if (!attempts.some((a) => a.ok)) {
          throw new TpuSendError(
            { kind: 'all-failed', attempts: attempts.length },
            `all ${attempts.length} leader attempt(s) failed`,
          );
        }

        return { signature: sig, attempts };
      },

      async close(): Promise<void> {
        if (closing) return;
        closing = true;
        // Drain all in-flight sends before aborting the signal.
        await Promise.allSettled([...inFlight]);
        abortAll();
        await dispose();
      },
    };

    return client;
  } catch (err) {
    // Partial-init failed — unwind whatever was built.
    await dispose();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spin-wait up to 5 s for the snapshot to contain at least one leader.
 * Returns early (success or deadline) regardless — caller continues.
 */
async function waitForSnapshot(ref: AtomicSnapshotRef, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!signal.aborted) {
    if (ref.load().leaders.length > 0) return;
    if (Date.now() >= deadline) return; // give up — sendRawTransaction will throw no-leaders
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

/**
 * Extract the transaction signature from raw wire-format bytes.
 *
 * Solana wire format: [compact-u16 numSigs] [64-byte sigs...] [message]
 * For any realistic transaction (numSigs < 128) the compact-u16 encodes
 * as a single byte, so the first signature lives at bytes [1..65].
 *
 * Limitation: transactions with >= 128 signatures use a 2-byte compact-u16
 * prefix; this code will silently read the wrong bytes in that (essentially
 * impossible in practice) case.
 */
function computeSignature(tx: Uint8Array): Signature {
  const sigBytes = tx.subarray(1, 65);
  // getBase58Decoder().decode() returns a base58 string; brand-cast to Signature.
  return getBase58Decoder().decode(sigBytes) as unknown as Signature;
}
