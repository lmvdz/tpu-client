# Migrating from v1 to v2

## Summary

v1 exported a `TpuConnection` class that extended `@solana/web3.js` `Connection`. You could drop it in wherever you used `Connection` and call `sendTransaction(tx, signers)` as usual.

v2 is a standalone factory built on `@solana/kit` 3.x. There is no `Connection` wrapper. Transaction building, signing, and serialization are handled by `@solana/kit`; the TPU client only deals in already-signed wire bytes.

---

## Before (v1)

```ts
import { TpuConnection } from 'tpu-client';
import { Transaction, Keypair, SystemProgram } from '@solana/web3.js';

const tpu = await TpuConnection.load('https://api.mainnet-beta.solana.com', {
  commitment: 'confirmed',
});

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: recipient,
    lamports: 1000,
  }),
);

const sig = await tpu.sendTransaction(tx, [signer]);
```

---

## After (v2)

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

const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
const rpcSubscriptions = createSolanaRpcSubscriptions(
  'wss://api.mainnet-beta.solana.com',
);

// Load your staked identity keypair (64-byte solana-keygen file).
const secret = new Uint8Array(
  JSON.parse(readFileSync('/path/to/id.json', 'utf8')) as number[],
);
const identity = await ed25519KeyPairFromSolanaSecret(secret);

const tpu = await createTpuClient({ rpc, rpcSubscriptions, identity });

// Build + sign your transaction with @solana/kit.
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

// Serialize to wire bytes.
const txBytes = new Uint8Array(
  Buffer.from(getBase64EncodedWireTransaction(signedTx), 'base64'),
);

// Send and confirm.
const confirm = sendAndConfirmTpuTransactionFactory({ tpu, rpc, rpcSubscriptions });
const { signature, attempts } = await confirm(txBytes, {
  commitment: 'confirmed',
  abortSignal: new AbortController().signal,
  lastValidBlockHeight: blockhash.lastValidBlockHeight,
});

console.log(signature, attempts);
await tpu.close();
```

---

## Breaking changes

| v1 | v2 |
|---|---|
| `TpuConnection.load(url)` | `createTpuClient({ rpc, rpcSubscriptions, identity? })` |
| `sendTransaction(tx, signers)` | Build signed bytes with `@solana/kit`, call `sendRawTransaction(bytes)` |
| `sendRawTransaction(bytes)` returned `string` (signature) | Returns `Promise<{ signature: Signature; attempts: LeaderAttempt[] }>` |
| `sendAbortableTransaction(tx, signers, signal)` | Pass `{ signal }` as second arg to `sendRawTransaction` |
| `sendAndConfirmRawTransaction(bytes)` | Use `sendAndConfirmTpuTransactionFactory` |
| `@solana/web3.js` dependency | Migrate to `@solana/kit` — no `web3.js` required |
| Node.js version unpinned | Node ≥ 22.11 required |
| Returns `string` signature | Returns `{ signature, attempts }` object |

---

## New capabilities in v2

- **Staked QoS** — pass `identity: CryptoKeyPair` to get stake-weighted QUIC streams.
- **`onEvent` hook** — stable `TpuEvent` union for Prometheus / OpenTelemetry integration.
- **Per-attempt error detail** — `attempts[]` tells you which leaders succeeded or failed and why.
- **Server cert pinning** — leader Ed25519 identity is verified against the QUIC peer cert.
- **Graceful `close()`** — drains in-flight sends before tearing down connections.
- **Epoch-boundary handling** — leader schedule is fetched across epoch boundaries automatically.

---

## Keeping v1 temporarily

If you need to run v1 alongside v2 during migration, you can alias the packages in your `package.json`:

```json
{
  "dependencies": {
    "tpu-client-v1": "npm:tpu-client@^1",
    "tpu-client": "^2"
  }
}
```
