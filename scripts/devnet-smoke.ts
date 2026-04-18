/**
 * devnet-smoke.ts — Manual end-to-end prover against Solana devnet.
 *
 * Manual tool; not run in CI. Takes ~30-60s depending on devnet congestion.
 *
 * Usage:
 *   npx tsx scripts/devnet-smoke.ts [--yes]
 *   # or: DEVNET_SMOKE=1 npx tsx scripts/devnet-smoke.ts
 *
 * What it does:
 *   1. Loads or generates a Solana keypair.
 *   2. Connects to devnet RPC + WebSocket.
 *   3. Airdrops 1 SOL if balance < 0.1 SOL, waits for confirmation.
 *   4. Builds a self-transfer of 0.0001 SOL (payer → payer).
 *   5. Sends + confirms via createTpuClient + sendAndConfirmTpuTransactionFactory.
 *   6. Prints signature, attempts[], and getStats().
 *   7. Gracefully close()s.
 */

import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import {
  generateKeyPair,
  getAddressFromPublicKey,
  signBytes,
} from '@solana/kit';
import type { Signature } from '@solana/kit';
import { createTpuClient } from '../src/tpu-client.js';
import { sendAndConfirmTpuTransactionFactory } from '../src/confirm.js';
import type { TpuEvent } from '../src/events.js';

// ---------------------------------------------------------------------------
// Gate: require explicit opt-in so this is never run accidentally.
// ---------------------------------------------------------------------------

const allowed =
  process.env['DEVNET_SMOKE'] === '1' || process.argv.includes('--yes');

if (!allowed) {
  console.error(
    'devnet-smoke: must pass --yes or set DEVNET_SMOKE=1 to run this script.',
  );
  console.error('  DEVNET_SMOKE=1 npx tsx scripts/devnet-smoke.ts');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = 'https://api.devnet.solana.com';
const WS_URL = 'wss://api.devnet.solana.com';
const MIN_SOL = 0.1;
const AIRDROP_LAMPORTS = 1_000_000_000n; // 1 SOL
const TRANSFER_LAMPORTS = 100_000n; // 0.0001 SOL

// ---------------------------------------------------------------------------
// Minimal transaction builder (system transfer: payer → payer)
// ---------------------------------------------------------------------------

/**
 * Build a minimal legacy transaction for a self-transfer.
 * We construct the wire bytes manually to avoid depending on @solana-program/system
 * at runtime — this script only needs to produce a valid signed tx byte array.
 *
 * Layout (legacy):
 *   [1]        sig count = 1
 *   [64]       signature placeholder (filled after signing)
 *   [1]        num_required_signatures = 1
 *   [1]        num_readonly_signed = 0
 *   [1]        num_readonly_unsigned = 1  (system program)
 *   [1]        account key count = 3
 *   [32*3]     keys: [payer, payer (receiver), system program]
 *   [32]       recent blockhash
 *   [1]        instruction count = 1
 *   [1]        program id index = 2 (system program)
 *   [1]        account count = 2
 *   [1,1]      account indices [0, 1]
 *   [2]        data len (LE u16) = 12
 *   [4]        SystemInstruction::Transfer = 2 (LE u32)
 *   [8]        lamports (LE u64)
 */
async function buildSelfTransferTx(params: {
  payerPublicKeyBytes: Uint8Array;
  blockhash: Uint8Array; // 32 bytes
  lamports: bigint;
  sign: (msg: Uint8Array) => Promise<Uint8Array>;
}): Promise<Uint8Array> {
  const { payerPublicKeyBytes, blockhash, lamports, sign } = params;

  // System program ID (all zeros except last byte = 0)
  const systemProgram = new Uint8Array(32); // all zeros

  // Build message
  const message = new Uint8Array([
    // Header
    1, // num_required_signatures
    0, // num_readonly_signed_accounts
    1, // num_readonly_unsigned_accounts
    // Account keys (3)
    3,
    ...payerPublicKeyBytes, // index 0: payer (signer, writable)
    ...payerPublicKeyBytes, // index 1: recipient (writable) — same as payer for self-transfer
    ...systemProgram, // index 2: system program (readonly)
    // Recent blockhash
    ...blockhash,
    // Instructions (1)
    1,
    // Instruction: program_id_index=2
    2,
    // Account indices count=2, indices=[0,1]
    2,
    0,
    1,
    // Data: len=12 (LE u16), SystemInstruction::Transfer=2 (LE u32), lamports (LE u64)
    12,
    0,
    2,
    0,
    0,
    0,
    ...leU64(lamports),
  ]);

  const signature = await sign(message);

  // Wire format: [sig_count=1][sig64][message]
  return new Uint8Array([1, ...signature, ...message]);
}

function leU64(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== devnet-smoke ===');
  console.log(`RPC  : ${RPC_URL}`);
  console.log(`WS   : ${WS_URL}`);
  console.log('');

  // 1. Generate ephemeral keypair (no wallet file needed for smoke test)
  const keypair = await generateKeyPair();
  const payerAddress = await getAddressFromPublicKey(keypair.publicKey);
  console.log(`Payer: ${payerAddress}`);

  // Extract raw public key bytes for tx building
  const rawPublicKey = await crypto.subtle.exportKey('raw', keypair.publicKey);
  const payerPublicKeyBytes = new Uint8Array(rawPublicKey);

  // Sign helper
  const sign = async (msg: Uint8Array): Promise<Uint8Array> => {
    const sigBytes = await signBytes(keypair.privateKey, msg);
    return sigBytes;
  };

  // 2. Create RPC clients
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);

  // 3. Check balance and airdrop if needed
  const balanceResult = await rpc
    .getBalance(payerAddress, { commitment: 'confirmed' })
    .send();
  const balanceSol = Number(balanceResult.value) / 1e9;
  console.log(`Balance: ${balanceSol.toFixed(6)} SOL`);

  if (balanceSol < MIN_SOL) {
    console.log(`Balance < ${MIN_SOL} SOL — requesting airdrop of 1 SOL...`);
    const airdropSig = await rpc
      .requestAirdrop(payerAddress, AIRDROP_LAMPORTS)
      .send();
    console.log(`Airdrop tx: ${airdropSig}`);

    // Wait for airdrop confirmation
    console.log('Waiting for airdrop confirmation...');
    const airdropStart = Date.now();
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(2_000);
      const sig = await rpc
        .getSignatureStatuses([airdropSig as Signature])
        .send();
      const status = sig.value[0];
      if (
        status != null &&
        status.confirmationStatus === 'confirmed' &&
        status.err == null
      ) {
        console.log(`Airdrop confirmed in ${Date.now() - airdropStart}ms`);
        break;
      }
      if (attempt === 59) {
        throw new Error('Airdrop not confirmed after 120s');
      }
    }
  }

  // 4. Build self-transfer tx
  console.log('\nBuilding self-transfer transaction...');
  const { value: latestBlockhash, context } = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send();

  const blockhashBytes = base58Decode(latestBlockhash.blockhash);
  const txBytes = await buildSelfTransferTx({
    payerPublicKeyBytes,
    blockhash: blockhashBytes,
    lamports: TRANSFER_LAMPORTS,
    sign,
  });
  console.log(`Tx bytes: ${txBytes.length} bytes`);
  console.log(`Last valid block height: ${latestBlockhash.lastValidBlockHeight}`);
  void context; // suppress unused warning

  // 5. Create TpuClient
  const events: TpuEvent[] = [];
  const client = await createTpuClient({
    rpc: rpc as Parameters<typeof createTpuClient>[0]['rpc'],
    rpcSubscriptions:
      rpcSubscriptions as Parameters<
        typeof createTpuClient
      >[0]['rpcSubscriptions'],
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'leaders-refresh') {
        console.log(`  [event] leaders-refresh: ${e.count} leaders at slot ${e.startSlot}`);
      } else if (e.type === 'ephemeral-identity') {
        console.log('  [event] ephemeral-identity (no staked key provided)');
      } else if (e.type === 'ready') {
        console.log('  [event] ready');
      } else if (e.type === 'error') {
        console.log(`  [event] error: ${JSON.stringify(e.error)}`);
      }
    },
  });

  console.log('TpuClient created — waiting for ready...');
  await client.ready;
  console.log('Client ready.\n');

  // 6. Send + confirm
  const sendAndConfirm = sendAndConfirmTpuTransactionFactory({
    tpu: client,
    rpc: rpc as Parameters<typeof sendAndConfirmTpuTransactionFactory>[0]['rpc'],
    rpcSubscriptions:
      rpcSubscriptions as Parameters<
        typeof sendAndConfirmTpuTransactionFactory
      >[0]['rpcSubscriptions'],
  });

  console.log('Sending self-transfer via TPU...');
  const sendStart = Date.now();

  const result = await sendAndConfirm(txBytes, {
    commitment: 'confirmed',
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  const elapsed = Date.now() - sendStart;

  console.log('\n=== RESULT ===');
  console.log(`Signature : ${result.signature}`);
  console.log(`Elapsed   : ${elapsed}ms`);
  console.log(`Commitment: ${result.commitment}`);
  console.log(`Attempts  :`);
  for (const attempt of result.attempts) {
    if (attempt.ok) {
      console.log(`  [ok]   ${attempt.identity} (${attempt.tpuQuicAddr}) rtt=${attempt.rttMs}ms`);
    } else {
      console.log(`  [fail] ${attempt.identity} — ${JSON.stringify(attempt.error)}`);
    }
  }

  console.log('\n=== STATS ===');
  const stats = client.getStats();
  console.log(JSON.stringify(stats, null, 2));

  // 7. Graceful close
  console.log('\nClosing client...');
  await client.close();
  console.log('Done.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal base58 decoder for blockhash (32-byte result). */
function base58Decode(s: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58n;
  let n = 0n;
  for (const c of s) {
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 char: ${c}`);
    n = n * BASE + BigInt(idx);
  }
  // Count leading 1s (zero bytes)
  let leadingZeros = 0;
  for (const c of s) {
    if (c !== '1') break;
    leadingZeros++;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
