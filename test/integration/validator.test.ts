import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  lamports,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { createTpuClient, sendAndConfirmTpuTransactionFactory } from '../../src/index.js';
import { spawn } from 'node:child_process';

describe.skipIf(!process.env['TPU_INTEGRATION'])(
  'TPU client against solana-test-validator',
  () => {
    let validator: ReturnType<typeof spawn>;
    const rpcUrl = 'http://127.0.0.1:8899';
    const wsUrl = 'ws://127.0.0.1:8900';

    beforeAll(async () => {
      validator = spawn('solana-test-validator', ['--reset', '--quiet'], { stdio: 'ignore' });
      await waitForReady(rpcUrl, 30_000);
    }, 45_000);

    afterAll(() => {
      validator.kill('SIGTERM');
    });

    it(
      'sends and confirms a transfer via TPU',
      async () => {
        const rpc = createSolanaRpc(rpcUrl);
        const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
        const tpu = await createTpuClient({ rpc, rpcSubscriptions });

        const payer = await generateKeyPairSigner();
        const recipient = await generateKeyPairSigner();

        // Airdrop to fund the payer.
        await rpc.requestAirdrop(payer.address, lamports(1_000_000_000n)).send();
        await new Promise((r) => setTimeout(r, 2_000));

        const { value: blockhash } = await rpc.getLatestBlockhash().send();
        const msg = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(payer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) =>
            appendTransactionMessageInstruction(
              getTransferSolInstruction({
                source: payer,
                destination: recipient.address,
                amount: lamports(1000n),
              }),
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
      },
      60_000,
    );
  },
);

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      });
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('validator not ready within timeout');
}
