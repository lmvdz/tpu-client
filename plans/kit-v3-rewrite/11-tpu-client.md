# 11 — tpu-client.ts

STATUS: open
PRIORITY: p0
COMPLEXITY: architectural
BLOCKED_BY: 02, 05, 06, 07, 08, 09, 10
VERIFY: `test -f src/slot-tracker.ts -a -f src/leader-cache.ts -a -f src/quic-sender.ts -a -f src/quic-pool.ts -a -f src/identity.ts`
TOUCHES: src/tpu-client.ts

## Goal
Public factory `createTpuClient` that wires every module together. Handles AsyncDisposableStack-style partial-init cleanup, exposes `ready`/`sendRawTransaction`/`close`, and orchestrates fan-out + attempts + event emission.

## Approach

```ts
import type { Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi, Signature } from '@solana/kit';
import { getBase58Decoder } from '@solana/kit';
import { buildIdentity, type TpuIdentity } from './identity.js';
import { createSlotTracker } from './slot-tracker.js';
import { startLeaderCache } from './leader-cache.js';
import { QuicPool } from './quic-pool.js';
import { openTpuQuicConn, sendOnce } from './quic-sender.js';
import { AtomicSnapshotRef, EMPTY_SNAPSHOT } from './route-snapshot.js';
import { noopEmitter, type EventEmitter, type LeaderAttempt } from './events.js';
import { TpuSendError } from './errors.js';
import type { Address } from '@solana/kit';

export interface CreateTpuClientOptions {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  identity?: CryptoKeyPair;
  fanoutSlots?: number;
  maxStreamsPerConn?: { staked: number; unstaked: number };
  poolCap?: number;
  onEvent?: EventEmitter;
  signal?: AbortSignal;
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

const DEFAULT_FANOUT = 4;
const DEFAULT_MAX_STREAMS = { staked: 128, unstaked: 8 };

export async function createTpuClient(opts: CreateTpuClientOptions): Promise<TpuClient> {
  const emit = opts.onEvent ?? noopEmitter;
  const externalSignal = opts.signal ?? new AbortController().signal;
  const internalAbort = new AbortController();
  const abortAll = () => internalAbort.abort();
  externalSignal.addEventListener('abort', abortAll, { once: true });
  const signal = internalAbort.signal;

  // Partial-init cleanup using a manual disposal stack.
  const disposers: Array<() => Promise<void> | void> = [];
  const dispose = async () => {
    for (const d of disposers.reverse()) { try { await d(); } catch {} }
  };

  try {
    // 1. Mint identity / cert.
    const tpuIdentity: TpuIdentity = await buildIdentity(opts.identity);
    if (tpuIdentity.ephemeral) {
      // One-shot warning — callers who want production QoS must pass identity.
      console.warn('[tpu-client] using ephemeral identity — unstaked QoS; pass opts.identity for staked treatment');
    }

    // 2. Slot tracker (sets up subscription).
    const slotTracker = await createSlotTracker({
      rpc: opts.rpc,
      rpcSubscriptions: opts.rpcSubscriptions,
      emit,
      signal,
    });
    disposers.push(() => { /* tracker tied to signal */ });

    // 3. Route snapshot ref.
    const snapshotRef = new AtomicSnapshotRef(EMPTY_SNAPSHOT);

    // 4. Leader cache refresh loop.
    await startLeaderCache({
      rpc: opts.rpc,
      fanoutSlots: opts.fanoutSlots ?? DEFAULT_FANOUT,
      emit,
      signal,
      getCurrentSlot: () => {
        try { return slotTracker.estimate(); } catch { return 0n; }
      },
      snapshotRef,
    });

    // 5. Wait for first real snapshot + slot tracker ready.
    await slotTracker.ready;
    // Give the refresh loop a tick to publish its first snapshot.
    await waitForSnapshot(snapshotRef, signal);

    emit({ type: 'ready' });

    // 6. Pool.
    const maxStreams = opts.maxStreamsPerConn ?? DEFAULT_MAX_STREAMS;
    const stakedIdentities = new Set<Address>(); // populated by leader-cache events in the future
    const pool = new QuicPool({
      openConn: (args) => openTpuQuicConn({ ...args, tpuIdentity, emit }),
      maxStreamsFor: (identity) => stakedIdentities.has(identity) ? maxStreams.staked : maxStreams.unstaked,
      poolCap: opts.poolCap,
      emit,
      signal,
      getUpcomingIdentities: () => new Set(snapshotRef.load().leaders.map((l) => l.identity)),
    });
    disposers.push(() => { /* pool tied to signal */ });

    const inFlight = new Set<Promise<unknown>>();
    let closing = false;

    const client: TpuClient = {
      ready: Promise.resolve(),
      async sendRawTransaction(tx, sendOpts) {
        if (closing) throw new TpuSendError({ kind: 'aborted' });
        const sig = computeSignature(tx);
        const snap = snapshotRef.load();
        const leaders = snap.leaders.slice(0, sendOpts?.fanoutSlots ?? opts.fanoutSlots ?? DEFAULT_FANOUT);
        if (leaders.length === 0) throw new TpuSendError({ kind: 'no-leaders' });

        const attempts: LeaderAttempt[] = [];
        const sendSignal = sendOpts?.signal ?? signal;

        // Fan out in parallel.
        const promises = leaders.map(async (leader) => {
          if (!leader.tpuQuicAddr) {
            attempts.push({ identity: leader.identity, tpuQuicAddr: '', ok: false, error: { kind: 'no-tpu-addr', identity: leader.identity } });
            return;
          }
          let entry;
          try {
            entry = await pool.acquire(leader.identity, leader.tpuQuicAddr);
          } catch (err) {
            attempts.push({
              identity: leader.identity,
              tpuQuicAddr: leader.tpuQuicAddr,
              ok: false,
              error: { kind: 'connect-timeout', identity: leader.identity },
            });
            return;
          }
          try {
            const result = await sendOnce(entry, tx, sendSignal);
            if ('rttMs' in result) {
              attempts.push({ identity: leader.identity, tpuQuicAddr: leader.tpuQuicAddr, ok: true, rttMs: result.rttMs });
            } else {
              attempts.push({ identity: leader.identity, tpuQuicAddr: leader.tpuQuicAddr, ok: false, error: result });
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

        const anyOk = attempts.some((a) => a.ok);
        if (!anyOk) {
          throw new TpuSendError({ kind: 'no-leaders' }, `all ${attempts.length} leaders failed`);
        }
        return { signature: sig, attempts };
      },
      async close() {
        if (closing) return;
        closing = true;
        await Promise.allSettled([...inFlight]);
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

async function waitForSnapshot(ref: AtomicSnapshotRef, signal: AbortSignal): Promise<void> {
  const started = Date.now();
  while (!signal.aborted) {
    if (ref.load().leaders.length > 0) return;
    if (Date.now() - started > 5_000) return; // give up — sendRawTransaction will throw no-leaders
    await new Promise((r) => setTimeout(r, 50));
  }
}

function computeSignature(tx: Uint8Array): Signature {
  // Solana wire format: [numSignatures (compact-u16)] [signatures...] [message]
  // First signature lives after the 1-byte length prefix for any tx with < 128 sigs.
  const sig = tx.subarray(1, 65);
  return getBase58Decoder().decode(sig) as unknown as Signature;
}
```

## Decisions

- **Signature computed locally** from tx bytes (no network roundtrip needed). Wire format: 1-byte sig count + 64-byte signatures. Handle compact-u16 for the count only if someone passes a tx with >127 sigs (essentially never in practice; document the simplification).
- **Partial-init cleanup**: disposer array unwound on throw. AsyncDisposableStack (ES2024) would be cleaner but requires tsconfig `target: ES2024` — use the manual pattern for now.
- **Ready promise**: the outer `TpuClient.ready` is a trivial `Promise.resolve()` because `createTpuClient` already awaits slot-tracker readiness and first snapshot. If callers want to know when to start sending, they just `await createTpuClient(...)`.
- **Close semantics**: drains in-flight `sendRawTransaction` calls, then aborts. New sends during close throw `TpuSendError`.
- **Error model**: throws `TpuSendError` on no-leaders / all-failed / aborted; otherwise returns `SendResult` with per-attempt details. Partial failure is NOT a throw.
- **`stakedIdentities`**: placeholder empty Set — real stake lookup is a follow-up (use `getVoteAccounts` in leader-cache). Document as known limitation; `maxStreams.unstaked` conservatively applied.

## Verify

```bash
npx tsc --noEmit
grep -q "createTpuClient" src/tpu-client.ts
grep -q "dispose\|close" src/tpu-client.ts
```

Integration test (concern 15) is the real verification.
