import type {
  Commitment,
  Rpc,
  RpcSubscriptions,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
} from '@solana/kit';
import {
  createBlockHeightExceedencePromiseFactory,
  createRecentSignatureConfirmationPromiseFactory,
} from '@solana/transaction-confirmation';
import type { TpuClient, SendResult } from './tpu-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TpuConfirmFactoryCfg {
  tpu: TpuClient;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

export interface TpuConfirmOptions {
  commitment: Commitment;
  abortSignal?: AbortSignal;
  lastValidBlockHeight: bigint;
}

export interface TpuConfirmResult extends SendResult {
  commitment: Commitment;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a `sendAndConfirmTpuTransaction` function that sends a raw
 * transaction via the TPU fast-path and then waits for on-chain confirmation
 * using kit's block-height + signature-status racing strategy.
 *
 * Throws when:
 *   - the blockhash's last-valid block height is exceeded
 *   - the caller's `abortSignal` fires
 *   - the transaction fails on-chain
 */
export function sendAndConfirmTpuTransactionFactory(
  cfg: TpuConfirmFactoryCfg,
): (tx: Uint8Array, opts: TpuConfirmOptions) => Promise<TpuConfirmResult> {
  // kit's factory overloads are branded per cluster, but the implementation
  // accepts any Rpc/RpcSubscriptions that satisfy the required method shapes.
  // Our SolanaRpcApi / SolanaRpcSubscriptionsApi satisfy those shapes, so we
  // cast through unknown to the devnet overload (all overloads produce the
  // same function type at runtime).
  type DevnetRpc = Parameters<typeof createBlockHeightExceedencePromiseFactory>[0]['rpc'];
  type DevnetSubs = Parameters<
    typeof createBlockHeightExceedencePromiseFactory
  >[0]['rpcSubscriptions'];
  type DevnetSigRpc = Parameters<
    typeof createRecentSignatureConfirmationPromiseFactory
  >[0]['rpc'];
  type DevnetSigSubs = Parameters<
    typeof createRecentSignatureConfirmationPromiseFactory
  >[0]['rpcSubscriptions'];

  const rpcAsDevnet = cfg.rpc as unknown as DevnetRpc;
  const subsAsDevnet = cfg.rpcSubscriptions as unknown as DevnetSubs;
  const sigRpcAsDevnet = cfg.rpc as unknown as DevnetSigRpc;
  const sigSubsAsDevnet = cfg.rpcSubscriptions as unknown as DevnetSigSubs;

  const getBlockHeightExceedencePromise = createBlockHeightExceedencePromiseFactory({
    rpc: rpcAsDevnet,
    rpcSubscriptions: subsAsDevnet,
  });

  const getRecentSignatureConfirmationPromise =
    createRecentSignatureConfirmationPromiseFactory({
      rpc: sigRpcAsDevnet,
      rpcSubscriptions: sigSubsAsDevnet,
    });

  return async function sendAndConfirmTpuTransaction(
    tx: Uint8Array,
    opts: TpuConfirmOptions,
  ): Promise<TpuConfirmResult> {
    const abortSignal = opts.abortSignal ?? new AbortController().signal;

    // 1. Send via TPU (parallel fan-out to upcoming leaders).
    const sendResult = await cfg.tpu.sendRawTransaction(tx, {
      signal: abortSignal,
    });

    // 2. Race block-height exceedence vs. signature confirmation.
    //    We invoke the factories directly to avoid constructing a full
    //    Transaction object (which requires branded messageBytes). kit's
    //    waitForRecentTransactionConfirmation does the same internally.
    await Promise.race([
      getRecentSignatureConfirmationPromise({
        abortSignal,
        commitment: opts.commitment,
        signature: sendResult.signature,
      }),
      getBlockHeightExceedencePromise({
        abortSignal,
        commitment: opts.commitment,
        lastValidBlockHeight: opts.lastValidBlockHeight,
      }),
    ]);

    return { ...sendResult, commitment: opts.commitment };
  };
}
