# tpu-client

TPU-direct transaction submission for `@solana/kit` apps — send transactions straight to upcoming leaders over QUIC, bypassing RPC rate limits and reducing time-to-land.

---

## What this is

`tpu-client` is a TypeScript library that opens QUIC connections to the next N Solana leader nodes and fans out your signed transaction bytes directly, rather than routing through an RPC `sendTransaction` call. This mirrors what the Solana CLI and the Rust `TpuClient` do under the hood.

**What it solves:**

- RPC `sendTransaction` limits (rate limits, propagation lag, single-node SPF).
- Opaque landing failures — you get per-leader attempt results with RTTs and error kinds.
- Firedancer compatibility — ALPN negotiation (`solana-tpu`) is handled automatically.
- Observability gaps — a stable `TpuEvent` union lets you wire Prometheus counters without patching the library.

Built on `@solana/kit` 3.x primitives (no `@solana/web3.js` dependency), `@matrixai/quic` for QUIC transport, and `@peculiar/x509` for X.509 cert generation.

---

## When to use it vs alternatives

| Option | Hosted? | Stake-weighted QoS | Extra fees | Notes |
|---|---|---|---|---|
| **tpu-client** | No — self-hosted | Yes, via your own staked keypair | None | Pure TS, open source, you control the identity |
| **Helius `sendSmartTransaction`** | Yes | Helius handles it | Per-request or subscription | Easiest path if you already use Helius RPC |
| **Jito bundle endpoint** | Yes | Jito validators only | Tip required | Optimal for MEV / priority ordering within a block |
| **Triton Jet** | Yes | Triton infrastructure | Subscription | Managed TPU relay with SLA |

Use `tpu-client` when:
- You need full control over QoS identity and connection lifecycle.
- You want landing telemetry per attempt for SLAs or alerting.
- You are operating your own validator or staking infrastructure and already hold a funded identity keypair.
- You want a pure-TypeScript dependency with no managed-service lock-in.

---

## Install

Requires **Node.js ≥ 22.11** (ESM only; native QUIC bindings require a recent Node ABI).

```bash
npm install tpu-client @solana/kit @matrixai/quic @peculiar/x509
```

`@solana/kit`, `@matrixai/quic`, and `@peculiar/x509` are peer dependencies and must appear in your project's `dependencies`.

> **CF Workers / Bun / Deno:** `@matrixai/quic` compiles a native Node.js addon via `node-gyp`. CF Workers cannot load native bindings; the library will not work there. Bun and Deno may work if they expose a Node-compatible `node:crypto` and `node:net` surface, but this is untested. Lambda is supported — bundle with `node_modules` or use a Lambda Layer containing the native `.node` file.

---

## Quickstart

This example transfers 0.001 SOL from a generated payer to a recipient using the `@solana-program/system` package.

> **Note:** This is a compilable skeleton — payer must be pre-funded and the recipient must be a real address. See `test/integration/validator.test.ts` for a runnable example on `solana-test-validator`.

```ts
import { readFileSync } from 'node:fs';
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  address,
  lamports,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  createTpuClient,
  sendAndConfirmTpuTransactionFactory,
  ed25519KeyPairFromSolanaSecret,
} from 'tpu-client';

// 1. Load your staked identity (64-byte solana-keygen JSON array).
const secretBytes = new Uint8Array(
  JSON.parse(readFileSync('/path/to/stake-identity.json', 'utf8')) as number[],
);
const identity = await ed25519KeyPairFromSolanaSecret(secretBytes);

// 2. Create RPC clients.
const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
const rpcSubscriptions = createSolanaRpcSubscriptions(
  'wss://api.mainnet-beta.solana.com',
);

// 3. Create the TPU client. Resolves when leader schedule is primed.
const tpu = await createTpuClient({ rpc, rpcSubscriptions, identity });

// 4. Build and sign a SOL transfer with @solana/kit + @solana-program/system.
const payer = await generateKeyPairSigner(); /* replace with a pre-funded signer */
const RECIPIENT = address('/* replace with a real, funded recipient */');
const { value: blockhash } = await rpc.getLatestBlockhash().send();

const transferIx = getTransferSolInstruction({
  source: payer,
  destination: RECIPIENT,
  amount: lamports(1_000_000n), // 0.001 SOL
});

const signedTx = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(transferIx, m),
  ),
);
const txBytes = new Uint8Array(
  Buffer.from(getBase64EncodedWireTransaction(signedTx), 'base64'),
);

// 5. Send and confirm.
const confirm = sendAndConfirmTpuTransactionFactory({ tpu, rpc, rpcSubscriptions });
const ac = new AbortController();

const result = await confirm(txBytes, {
  commitment: 'confirmed',
  abortSignal: ac.signal,
  lastValidBlockHeight: blockhash.lastValidBlockHeight,
});

console.log('landed:', result.signature);
console.log('attempts:', result.attempts);

// 6. Graceful shutdown.
await tpu.close();
```

---

## Staked QoS

Solana's stake-weighted QoS (implemented in both the Agave validator and Firedancer) grants QUIC connections more stream-slots proportional to the sender's stake weight. Under leader load, unstaked connections are dropped first.

When you pass `identity: CryptoKeyPair` to `createTpuClient`, the library:

1. Mints a self-signed Ed25519 X.509 certificate from that keypair.
2. Presents it in the QUIC `ClientHello` so the validator can identify the sender and apply stake-weighting.

**Loading a `solana-keygen` keypair:**

`solana-keygen` saves keypairs as a JSON array of 64 bytes: the 32-byte seed followed by the 32-byte public key.

```ts
import { readFileSync } from 'node:fs';
import { ed25519KeyPairFromSolanaSecret } from 'tpu-client';

const raw = new Uint8Array(
  JSON.parse(readFileSync('/path/to/id.json', 'utf8')) as number[],
);
const identity = await ed25519KeyPairFromSolanaSecret(raw);
```

If you omit `identity`, an ephemeral (unstaked) keypair is generated and an `ephemeral-identity` `TpuEvent` fires. Ephemeral identities are fine for development but will be first-dropped by validators under production load.

> **Why staked identity matters more than a hint:** `@matrixai/quic@2.0.9` has a stream-creation bug that blocks sends against peers that advertise `initial_max_streams_uni: 0` and grant credit via `MAX_STREAMS` frames post-handshake. This is Agave's unstaked-QoS path (~80% of mainnet leaders). **Staked clients get nonzero initial credit from Agave and are unaffected.** We have a verified fix upstream-PR'd at https://github.com/MatrixAI/js-quic/pull/157 and a drop-in `patch-package` patch (`patches/@matrixai+quic+2.0.9.patch`) shipped in our tarball — `patch-package` is a dev-loop tool so you'd need to wire it in your own project root (or wait for the upstream release) to apply it. In the meantime: ship with a staked keypair.

> **Firedancer note:** Firedancer (and its hybrid Frankendancer variant) enforce ALPN — connections without `solana-tpu` are rejected. This library sets ALPN automatically. Firedancer has been handling approximately 20% of leader slots on mainnet.

---

## Events

Pass `onEvent` to observe all internal state transitions:

```ts
import type { TpuEvent } from 'tpu-client';

const tpu = await createTpuClient({
  rpc,
  rpcSubscriptions,
  identity,
  onEvent(e: TpuEvent) {
    switch (e.type) {
      case 'send':
        successCounter.inc({ ok: String(e.attempts.some((a) => a.ok)) });
        e.attempts.forEach((a) => {
          attemptHistogram.observe({ leader: a.identity, ok: String(a.ok) }, a.rttMs ?? 0);
        });
        break;
      case 'slot-stall':
        slotStallGauge.set(e.lastSlotAgeMs);
        break;
      case 'cert-pin-mismatch':
        alertManager.fire(`cert mismatch for leader ${e.identity}`);
        break;
      case 'error':
        errorCounter.inc({ kind: e.error.kind });
        break;
    }
  },
});
```

**`TpuEvent` union — stable schema:**

| `type` | Key fields | Meaning |
|---|---|---|
| `ready` | — | Slot tracker primed, first snapshot loaded |
| `slot` | `slot`, `parent`, `skipped` | New slot notification; `skipped > 0` means gaps detected |
| `slot-stall` | `lastSlotAgeMs` | No slot notification for >2 s; falling back to `getSlot` polling |
| `leaders-refresh` | `startSlot`, `count`, `source` | Leader schedule snapshot updated |
| `cluster-refresh` | `nodes` | `getClusterNodes` re-fetched |
| `conn-open` | `identity` | QUIC connection opened to leader |
| `conn-close` | `identity`, `reason?` | QUIC connection closed |
| `conn-evict` | `identity`, `reason` | Connection evicted from pool (idle / non-upcoming / LRU cap) |
| `cert-pin-mismatch` | `identity`, `expected`, `got` | Server cert SPKI did not match gossip identity. In default `'observe'` mode this is informational only; in `'strict'` mode the leader is rejected and quarantined until the next cluster-refresh |
| `send` | `signature`, `attempts` | Fires once per `sendRawTransaction` with full attempt detail. `LeaderAttempt.ok: true` means the QUIC stream write completed successfully — this is **not** confirmation that the leader accepted or will include the transaction. Use `sendAndConfirmTpuTransactionFactory` for landing confirmation. |
| `error` | `error: TpuError` | Non-fatal error during background refresh |

**SemVer policy:** Adding a new `TpuEvent` variant is a **MINOR** version bump. If you use an exhaustive `switch` over `e.type`, include a `default:` branch so your code remains forward-compatible.

---

## Compatibility

### Alpenglow (SIMD-0326)

Alpenglow SIMD-0326, as specified, does not change TPU ingress — transactions continue to be forwarded to leaders over QUIC at the same TPU port. This client will be re-tested at activation. See the SIMD: https://github.com/solana-foundation/solana-improvement-documents/pull/228

### Firedancer / Frankendancer

Firedancer is Jump Trading's independent validator client. It requires:

- ALPN set to `solana-tpu` — handled automatically.
- A valid Ed25519 TLS certificate in the `ClientHello` — generated from your `identity` keypair.

Frankendancer (Firedancer networking + Agave consensus) has been handling roughly 20% of leader slots on mainnet. Tested against Agave (solana-test-validator for integration, mainnet nodes via the smoke script) and Frankendancer (mainnet smoke script). The nightly CI smoke probe re-verifies. See: https://docs.firedancer.io

### Server cert pinning: `pinMode`

Our QUIC client ALWAYS presents the client cert (required for stake-weighted QoS) and ALWAYS performs TLS. Whether we ALSO verify the **server's** cert pubkey against the gossip-advertised identity is governed by `pinMode`:

| Mode | Behavior | When to use |
|---|---|---|
| `'observe'` (default) | Accept the connection regardless of SPKI match; emit `cert-pin-mismatch` event when they don't match | The safe default. Works universally on mainnet. |
| `'strict'` | Reject connection on SPKI mismatch; quarantine the leader until cluster-refresh | Pure-Agave fleets where you have ground truth that every server presents an identity-signed cert. |
| `'off'` | Do not inspect server cert at all | Benchmarking, or environments where pin-mismatch noise is undesirable. |

**Why `'observe'` and not `'strict'` by default?** Empirical probing of mainnet-beta (April 2026, `npm run smoke:firedancer`) shows that **100% of Frankendancer nodes** and a **meaningful fraction of Agave nodes** present server certs whose SPKI does not equal the gossip identity — likely due to per-connection ephemeral certs, validator-side TLS terminators, or cloud-native load balancers in front of validator machines. Strict pinning would silently drop ~20%+ of the real leader schedule. In `'observe'` mode you still get the telemetry signal (the event fires) without the connectivity loss.

### web3.js v1 users

If you are migrating from the previous `TpuConnection` API (which extended `@solana/web3.js` `Connection`), see [MIGRATION.md](./MIGRATION.md).

### Serverless

| Platform | Status | Notes |
|---|---|---|
| AWS Lambda | Supported | Bundle `node_modules` with native `.node` file, or use a Lambda Layer |
| Google Cloud Functions | Supported | Same as Lambda — include native bindings in deployment package |
| CF Workers | **Not supported** | Native addons cannot load in the V8 isolate sandbox |
| Vercel Edge | **Not supported** | Same V8 isolate restriction as CF Workers |
| Vercel Node.js runtime | Supported | Uses Node.js; bundle native bindings |

---

## Reference

All exports from the `tpu-client` package:

> **Type documentation:** Full JSDoc is emitted to `lib/*.d.ts` during build. Use your IDE's hover/IntelliSense for field-level descriptions.

| Export | Kind | Description |
|---|---|---|
| `createTpuClient(opts)` | `async function` | Factory — resolves to a `TpuClient` after priming slot tracker and leader cache |
| `sendAndConfirmTpuTransactionFactory(cfg)` | `function` | Returns a `sendAndConfirm` function that sends via TPU and races block-height expiry vs. signature confirmation |
| `ed25519KeyPairFromSolanaSecret(bytes)` | `async function` | Import a 64-byte `solana-keygen` JSON file into a `CryptoKeyPair` |
| `ed25519KeyPairFromSeed(seed)` | `async function` | Import a 32-byte Ed25519 seed into a `CryptoKeyPair` |
| `buildIdentity(keypair?)` | `async function` | Build a `TpuIdentity` (keypair + X.509 cert) from a supplied or ephemeral keypair |
| `noopEmitter` | `const` | No-op `EventEmitter` — useful as a default when no `onEvent` handler is wired |
| `TpuSendError` | `class` | Thrown by `sendRawTransaction` on total failure; carries `details: TpuError`. Note: `createTpuClient` may throw `TypeError` for invalid construction options (e.g. `fanoutSlots` out of range) — those are programming errors, not `TpuSendError`. |
| `CreateTpuClientOptions` | `interface` | Options for `createTpuClient` |
| `TpuClient` | `interface` | `{ ready, sendRawTransaction, close, getStats }` — see below for `ready` and `close` semantics |
| `SendResult` | `interface` | `{ signature: Signature; attempts: LeaderAttempt[] }` |
| `TpuConfirmFactoryCfg` | `interface` | Config for `sendAndConfirmTpuTransactionFactory` |
| `TpuConfirmOptions` | `interface` | Per-call options: `commitment`, `abortSignal`, `lastValidBlockHeight` |
| `TpuConfirmResult` | `interface` | `SendResult & { commitment }` |
| `TpuEvent` | `type` | Discriminated union of all observable events |
| `TpuError` | `type` | Backward-compat union of `TpuLeaderError \| TpuSendFailure \| {kind:'slot-subscription'}` |
| `TpuLeaderError` | `type` | Per-leader attempt error variants (connect-timeout, write-timeout, etc.) |
| `TpuSendFailure` | `type` | Top-level send failure variants (aborted, no-leaders, all-failed, invalid-tx) |
| `LeaderAttempt` | `type` | Discriminated union on `ok`: `{ok:true; rttMs}` or `{ok:false; error: TpuLeaderError}`. `ok:true` means QUIC stream write completed — not landing confirmation. |
| `LeaderInfo` | `interface` | `{ identity: Address; tpuQuicAddr: string \| null; stake?: bigint }` |
| `LeaderDiscoveryProvider` | `interface` | Pluggable leader discovery interface |
| `TpuIdentity` | `interface` | `{ keyPair, certDer, certPem, privateKeyPem, pubkeyRaw, ephemeral }` |
| `EventEmitter` | `type` | `(e: TpuEvent) => void` |
| `evaluatePinDecision` | `function` | Pure unit-testable cert-pin decision logic; useful for testing custom transport wrappers — see "Custom transport wrappers" below |

### `TpuClient.ready` and `TpuClient.close` semantics

**`ready: Promise<void>`** — Resolves when the slot tracker is primed and the first leader snapshot has been loaded. May resolve with an empty snapshot after a 5 s internal deadline if the leader cache could not populate; in that case `sendRawTransaction` throws `{kind:'no-leaders'}` until a subsequent refresh succeeds.

**`close(opts?: { timeoutMs?: number }): Promise<void>`** — Drains in-flight sends up to `timeoutMs` (default 5000 ms), then aborts internal signal and disposes resources. Idempotent; second call is a no-op.

### Custom transport wrappers

If you are hand-rolling a custom QUIC transport (e.g. for testing), `evaluatePinDecision` lets you reuse the cert-pin logic without a live handshake:

```ts
import { evaluatePinDecision } from 'tpu-client';

// gossipSpki: the 32-byte Ed25519 pubkey bytes from getClusterNodes
// peerSpki:   the SPKI bytes extracted from the peer's X.509 cert DER
// pinMode:    'strict' | 'observe' | 'off'
const decision = evaluatePinDecision({
  gossipSpki: myGossipPubkeyBytes,
  peerSpki: extractedCertSpki,
  pinMode: 'strict',
});

// decision: { action: 'accept' | 'reject' | 'observe'; mismatch: boolean }
if (decision.action === 'reject') {
  throw new Error(`cert pin mismatch for ${leaderIdentity}`);
}
if (decision.mismatch) {
  onEvent({ type: 'cert-pin-mismatch', identity: leaderIdentity, ... });
}
```

---

## Running the integration test

**Prerequisites:**

- `solana-test-validator` on your `PATH` (install via Solana CLI: https://docs.solana.com/cli/install-solana-cli-tools)
- Node.js >= 22.11

**Steps:**

```bash
# Start a local test validator in the background (takes ~5 s to prime).
solana-test-validator &

# Run the integration suite (targets localhost:8899 by default).
npm run test:integration
```

Set `TPU_RPC_URL` and `TPU_WS_URL` to point at a different cluster:

```bash
TPU_RPC_URL=https://api.devnet.solana.com \
TPU_WS_URL=wss://api.devnet.solana.com \
npm run test:integration
```

**Expected runtime:** ~30–60 s against a local validator; up to 3 min against devnet depending on congestion.

---

## Deployment checklist

- Node ≥ 22.11 (ESM-only; no CommonJS support).
- `ulimit -n 4096` — pool cap × stream slots needs ample file descriptors.
- `UV_THREADPOOL_SIZE=16` — recommended for `@peculiar/x509` crypto ops under load.
- Stage a staked identity keypair; never ship an ephemeral identity in production.
- Consume `onEvent` into structured logs or a metrics sink — don't leave it unwired in production.
- CF Workers won't work (native QUIC binding); Lambda needs the prebuilt `.node` file bundled or in a Lambda Layer.

---

## Performance characteristics

No benchmarks have been captured yet. Architectural targets: up to 5k `sendRawTransaction` calls/s per client instance on commodity hardware with Node 22, subject to RPC refresh latency and leader QoS class. Real numbers will ship with the first stable release.

To verify the end-to-end path against devnet (airdrop → self-transfer → confirmed), run:

```bash
npm run smoke:devnet
# or: DEVNET_SMOKE=1 npx tsx scripts/devnet-smoke.ts
```

This takes ~30–60 s and prints the confirmed signature, per-leader attempt results, and a live `getStats()` snapshot. Not run in CI.

---

## License

MIT
