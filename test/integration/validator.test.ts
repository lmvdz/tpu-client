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
import { createTpuClient } from '../../src/index.js';
import type { TpuEvent } from '../../src/index.js';
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
        const events: TpuEvent[] = [];
        const tpu = await createTpuClient({
          rpc,
          rpcSubscriptions,
          // test-validator is a single validator — all 4 fanout attempts hit
          // the same loopback IP which trips Agave's per-IP rate limiter.
          fanoutSlots: 1,
          onEvent: (e) => events.push(e),
        });

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

        // Send via TPU directly. test-validator's unstaked-QoS path drops
        // some fraction of incoming tx chunks under its stream quota; retry
        // until landed or 20s budget exhausted. This models realistic TPU
        // client behavior: sends are fire-and-forget at the QUIC layer,
        // landing is observed via signature status polling.
        const signature = getSignatureFromTransaction(signedTx);
        let landed = false;
        let sendOk = false;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && !landed) {
          const sendResult = await tpu.sendRawTransaction(new Uint8Array(txBytes));
          if (sendResult.attempts.some((a) => a.ok)) sendOk = true;
          const statuses = await rpc.getSignatureStatuses([signature]).send();
          const status = statuses.value[0];
          if (status && status.confirmationStatus) {
            landed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        if (!landed) {
          console.error('did not land within 20s — event dump:');
          for (const e of events.slice(-20)) {
            try {
              console.error('  ', JSON.stringify(e, (_k, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 300));
            } catch {
              // ignore serialization failures on circular refs
            }
          }
        }
        expect(sendOk).toBe(true);
        expect(landed).toBe(true);
        await tpu.close({ timeoutMs: 2000 });
      },
      45_000,
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
