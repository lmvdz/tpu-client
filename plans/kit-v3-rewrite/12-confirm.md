# 12 — confirm.ts

STATUS: open
PRIORITY: p2
COMPLEXITY: architectural
BLOCKED_BY: 11 (VERIFY: `grep -q 'createTpuClient' src/tpu-client.ts`)
TOUCHES: src/confirm.ts

## Goal
Provide `sendAndConfirmTpuTransactionFactory` — a send+confirm helper that mirrors kit's `sendAndConfirmTransactionFactory` state machine but routes sends through our `TpuClient` instead of kit's RPC sender. Callers get signature + attempts + confirmed commitment.

## Approach

Kit's own `sendAndConfirmTransactionFactory` from `@solana/transaction-confirmation` uses `createRecentSignatureConfirmationPromiseFactory` + `createBlockHeightExceedencePromiseFactory` + race. We reuse those building blocks.

```ts
import type { Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi, Signature, Commitment } from '@solana/kit';
import { waitForRecentTransactionConfirmationUntilTimeout } from '@solana/transaction-confirmation';
import type { TpuClient, SendResult } from './tpu-client.js';

export interface TpuConfirmFactoryCfg {
  tpu: TpuClient;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

export interface TpuConfirmOptions {
  commitment: Commitment;
  abortSignal: AbortSignal;
  lastValidBlockHeight: bigint;
}

export interface TpuConfirmResult extends SendResult {
  commitment: Commitment;
}

export function sendAndConfirmTpuTransactionFactory(cfg: TpuConfirmFactoryCfg) {
  return async function sendAndConfirmTpuTransaction(
    tx: Uint8Array,
    opts: TpuConfirmOptions,
  ): Promise<TpuConfirmResult> {
    // 1. Send via TPU (parallel fan-out).
    const sendResult = await cfg.tpu.sendRawTransaction(tx, { signal: opts.abortSignal });

    // 2. Wait for confirmation using kit's confirmation machinery, keyed on signature.
    await waitForRecentTransactionConfirmationUntilTimeout({
      abortSignal: opts.abortSignal,
      commitment: opts.commitment,
      getBlockHeightExceedencePromise: createBlockHeightExceedencePromise(cfg.rpc, opts.lastValidBlockHeight, opts.abortSignal),
      getRecentSignatureConfirmationPromise: createSignatureConfirmationPromise(
        cfg.rpc,
        cfg.rpcSubscriptions,
        sendResult.signature,
        opts.commitment,
        opts.abortSignal,
      ),
    });

    return { ...sendResult, commitment: opts.commitment };
  };
}
```

## Notes for implementer

- The precise import paths inside `@solana/transaction-confirmation` and the shape of `createRecentSignatureConfirmationPromiseFactory` / `createBlockHeightExceedencePromiseFactory` are kit-internal. Check NOTES-04 (Q4) and kit 3.x source. If the helpers aren't pluggable, fall back to a handwritten state machine:
  ```
  race(
    subscribeSignatureNotifications(sig, commitment),
    pollUntilBlockHeightExceeds(lastValidBlockHeight),
    abortSignal
  )
  ```
- `Commitment` type: import from the path identified in NOTES-04 (Q4). If kit doesn't export it directly, define `type Commitment = 'processed' | 'confirmed' | 'finalized'` locally.
- On confirmation timeout / block-height exceedence, throw a clear error so callers can retry via the TPU path (send a new blockhash-bearing tx — the client doesn't re-sign).

## Verify

```bash
npx tsc --noEmit
grep -q "sendAndConfirmTpuTransactionFactory" src/confirm.ts
```

Integration test (concern 15): send + confirm a real tx via local validator; assert commitment reached. Abort during confirmation → AbortError propagates.
