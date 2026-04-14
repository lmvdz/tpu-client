# 15 — Integration test + README + MIGRATION + CHANGELOG

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 12, 13 (VERIFY: `grep -q 'createTpuClient' src/index.ts && grep -q 'sendAndConfirmTpuTransactionFactory' src/index.ts`)
TOUCHES: test/integration/validator.test.ts, README.md, MIGRATION.md, CHANGELOG.md

## Goal
(a) One end-to-end integration test against `solana-test-validator` proving a transaction lands via TPU-QUIC and confirms. (b) Rewrite the README for the v2 kit-native API. (c) Migration guide for v1 users. (d) Seed CHANGELOG.

## Approach

### A. Integration test

`test/integration/validator.test.ts`:

```ts
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createSolanaRpc, createSolanaRpcSubscriptions, generateKeyPairSigner, lamports, createTransactionMessage, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstruction, signTransactionMessageWithSigners, getSignatureFromTransaction, getBase64EncodedWireTransaction } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { createTpuClient, sendAndConfirmTpuTransactionFactory } from '../../src/index.js';
import { spawn } from 'node:child_process';

describe('TPU client against solana-test-validator', () => {
  let validator: ReturnType<typeof spawn>;
  const rpcUrl = 'http://127.0.0.1:8899';
  const wsUrl = 'ws://127.0.0.1:8900';

  beforeAll(async () => {
    validator = spawn('solana-test-validator', ['--reset', '--quiet'], { stdio: 'ignore' });
    await waitForReady(rpcUrl, 30_000);
  }, 45_000);

  afterAll(() => { validator.kill('SIGTERM'); });

  it('sends and confirms a transfer via TPU', async () => {
    const rpc = createSolanaRpc(rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    const tpu = await createTpuClient({ rpc, rpcSubscriptions });

    const payer = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();
    // airdrop
    await rpc.requestAirdrop(payer.address, lamports(1_000_000_000n)).send();
    await new Promise((r) => setTimeout(r, 2_000));

    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstruction(
        getTransferSolInstruction({ source: payer, destination: recipient.address, amount: lamports(1000n) }),
        m,
      ),
    );
    const signedTx = await signTransactionMessageWithSigners(msg);
    const txBytes = Buffer.from(getBase64EncodedWireTransaction(signedTx), 'base64');

    const confirm = sendAndConfirmTpuTransactionFactory({ tpu, rpc, rpcSubscriptions });
    const ac = new AbortController();
    const result = await confirm(new Uint8Array(txBytes), {
      commitment: 'confirmed',
      abortSignal: ac.signal,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    });

    expect(result.signature).toBe(getSignatureFromTransaction(signedTx));
    expect(result.attempts.some((a) => a.ok)).toBe(true);
    await tpu.close();
  }, 60_000);
});

async function waitForReady(url: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('validator not ready');
}
```

Skip in CI if `solana-test-validator` binary is not on PATH — guard via env `TPU_INTEGRATION=1`.

### B. README.md

Sections:
1. **What this is** — TPU-direct submission for `@solana/kit` apps. QUIC. Drop-in alternative to RPC `sendTransaction` for apps with landing-rate SLAs.
2. **When to use it vs alternatives** — Helius Sender / Jito / Triton Jet comparison. Key point: pure TS, no managed service, you bring your own staked identity.
3. **Install** — `npm i @solana/tpu-client @solana/kit @matrixai/quic @peculiar/x509`. Node ≥22.11.
4. **Quickstart** — minimal send + confirm example.
5. **Staked QoS** — explain stake-weighted QoS; how to load a 64-byte `solana-keygen` file into a `CryptoKeyPair`; why ephemeral identity is only for testing.
6. **Events** — `onEvent` hook, stable `TpuEvent` schema, example Prometheus mapping.
7. **Compatibility**:
   - Alpenglow (SIMD-0326) — ingress unchanged, will keep working through activation.
   - Firedancer (~20% of leaders) — ALPN is mandatory, handled automatically.
   - Current web3.js v1 users → see MIGRATION.md.
   - Serverless: native binding via `@matrixai/quic` is incompatible with CF Workers; Lambda requires layer. Document.
8. **Reference** — public API signatures (auto-generatable later; for now, a short table).

### C. MIGRATION.md

For users on v1 `TpuConnection`:

```md
# Migrating from v1 to v2

## Summary
v1 extended `@solana/web3.js` `Connection`. v2 is a standalone factory on `@solana/kit`.
No Connection wrapper anymore — send + confirm are separate helpers.

## Before (v1)
```ts
const tpu = await TpuConnection.load('https://api.mainnet-beta.solana.com');
const sig = await tpu.sendTransaction(tx, [signer]);
```

## After (v2)
```ts
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { createTpuClient, sendAndConfirmTpuTransactionFactory } from '@solana/tpu-client';

const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
const rpcSubscriptions = createSolanaRpcSubscriptions('wss://api.mainnet-beta.solana.com');
const tpu = await createTpuClient({ rpc, rpcSubscriptions, identity: yourStakedKeypair });

const { signature } = await tpu.sendRawTransaction(wireBytes);
// For send + confirm:
const confirm = sendAndConfirmTpuTransactionFactory({ tpu, rpc, rpcSubscriptions });
```

## Breaking changes
- Node 22.11+ required (was unpinned).
- `@solana/web3.js` dependency removed — migrate to `@solana/kit`.
- `sendTransaction(transaction, signers)` → build signed bytes yourself with kit, call `sendRawTransaction(bytes)`.
- `sendAbortableTransaction` → pass `opts.signal` to `sendRawTransaction`.
- `sendAndConfirmRawTransaction` → use `sendAndConfirmTpuTransactionFactory`.
- Return type changed from `string` to `{ signature, attempts }`.

## New capabilities
- Staked QoS via identity keypair.
- Event hook `onEvent` for observability.
- Per-attempt error detail.
- Cert pubkey pinning (v1 was `verifyPeer: false`).
```

### D. CHANGELOG.md

```md
# Changelog

## 2.0.0-alpha.0 (unreleased)
### Breaking
- Rewritten on `@solana/kit` 3.x. Drops `@solana/web3.js` v1 dependency.
- `TpuConnection` removed. Use `createTpuClient` factory.
- ESM-only. Node ≥22.11.
- `sendRawTransaction` now returns `{ signature, attempts }` instead of `string`.

### Added
- Staked QoS support via `opts.identity: CryptoKeyPair`.
- Server cert pubkey pinning (Ed25519 SPKI match vs expected leader identity).
- `onEvent` observability hook with stable `TpuEvent` union.
- `sendAndConfirmTpuTransactionFactory` send+confirm helper.
- `close()` for graceful drain.
- Epoch-boundary leader schedule union via `getLeaderSchedule(nextEpoch)`.

### Fixed
- Uninitialized `last_epoch_info_slot` causing spurious first-tick refetches.
- Dead `last_cluster_refresh` timer that never updated (cluster node refresh never ran).
- Fire-and-forget `sendRawTransaction` that returned before QUIC writes completed.
- Missing ALPN validation (Firedancer rejects without `solana-tpu`).
- Deprecated `onSlotUpdate` subscription.
```

## Verify

```bash
test -f README.md && test -f MIGRATION.md && test -f CHANGELOG.md
test -f test/integration/validator.test.ts
npx tsc --noEmit
# If solana-test-validator is available:
TPU_INTEGRATION=1 npx vitest run test/integration/
```

## Final step: install dependencies

After all files are in place, run:

```bash
npm install
```

Then verify everything compiles end-to-end:

```bash
npm run typecheck
npm run test:unit
```
