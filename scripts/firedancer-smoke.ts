/**
 * firedancer-smoke.ts — Manual operator smoke test for Firedancer/Frankendancer nodes.
 *
 * Usage:
 *   npx tsx scripts/firedancer-smoke.ts [rpc-url]
 *
 * Default RPC URL: https://api.mainnet-beta.solana.com
 *
 * What it does:
 *   1. Calls getClusterNodes() to enumerate all validators.
 *   2. Filters to Firedancer/Frankendancer nodes via version string heuristic (see below).
 *   3. Picks the first node with a tpuQuic address.
 *   4. Attempts a QUIC handshake via openTpuQuicConn using an ephemeral identity.
 *   5. Prints result: identity, addr, success/failure reason.
 *
 * Firedancer version heuristic:
 *   The version field in getClusterNodes() is a free-form string. Currently:
 *     - Firedancer reports versions like "0.1.x" or "fd1.x" (check contains "fd" prefix or "firedancer")
 *     - Frankendancer (hybrid) reports "frankendancer" or has version prefix "fd"
 *   We use a case-insensitive match for: "firedancer", "frankendancer", or prefix "fd\d"
 *   This heuristic will need updating as the ecosystem evolves.
 */

import { createSolanaRpc } from '@solana/kit';
import { buildIdentity } from '../src/identity.js';
import { openTpuQuicConn } from '../src/quic-sender.js';
import type { Address } from '@solana/kit';

// ---------------------------------------------------------------------------
// Firedancer version detection heuristic
// ---------------------------------------------------------------------------

/**
 * Returns true if the version string looks like a Firedancer or Frankendancer node.
 *
 * Heuristic (update as ecosystem versions evolve):
 *   - Case-insensitive substring "firedancer"
 *   - Case-insensitive substring "frankendancer"
 *   - Version starts with "fd" followed by a digit (e.g. "fd1.0.0")
 */
function isFiredancerVersion(version: string | null | undefined): boolean {
  if (version == null) return false;
  const v = version.toLowerCase();
  return (
    v.includes('firedancer') ||
    v.includes('frankendancer') ||
    /^fd\d/.test(v)
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rpcUrl = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
  console.log(`RPC: ${rpcUrl}`);

  const rpc = createSolanaRpc(rpcUrl);

  // 1. Fetch cluster nodes.
  console.log('Fetching cluster nodes...');
  const nodes = await rpc.getClusterNodes().send();
  console.log(`Total nodes: ${nodes.length}`);

  // 2. Filter to Firedancer/Frankendancer nodes with a tpuQuic address.
  const candidates = nodes.filter(
    (n) => isFiredancerVersion(n.version) && n.tpuQuic != null,
  );

  if (candidates.length === 0) {
    // Show sample of versions to help tune heuristic.
    const sample = nodes
      .slice(0, 20)
      .map((n) => n.version ?? '(null)')
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 10);
    console.log('No Firedancer/Frankendancer nodes found with tpuQuic.');
    console.log('Sample versions (first 20 nodes):', sample);
    console.log('Adjust isFiredancerVersion() heuristic if needed.');
    process.exit(1);
  }

  console.log(`Found ${candidates.length} Firedancer candidate(s) with tpuQuic.`);

  // 3. Pick the first candidate.
  const target = candidates[0]!;
  const identity = target.pubkey as Address;
  const addr = target.tpuQuic!;

  console.log(`\nTarget:`);
  console.log(`  identity : ${identity}`);
  console.log(`  tpuQuic  : ${addr}`);
  console.log(`  version  : ${target.version ?? '(unknown)'}`);
  console.log('');

  // 4. Build ephemeral identity for the QUIC handshake.
  const tpuIdentity = await buildIdentity(undefined); // ephemeral

  // 5. Attempt QUIC handshake.
  const events: string[] = [];
  const emit = (e: { type: string; [k: string]: unknown }): void => {
    events.push(JSON.stringify(e));
  };

  console.log('Attempting QUIC handshake...');
  try {
    const conn = await openTpuQuicConn({
      identity,
      addr,
      maxStreams: 1,
      tpuIdentity,
      emit,
    });

    console.log('SUCCESS');
    console.log(`  identity        : ${identity}`);
    console.log(`  addr            : ${addr}`);
    console.log(`  ALPN            : solana-tpu (accepted)`);
    console.log(`  cert pubkey     : matched (pin verified)`);
    console.log(`  conn.isOpen()   : ${conn.isOpen()}`);

    await conn.destroy('smoke-test-done');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log('FAILURE');
    console.log(`  identity : ${identity}`);
    console.log(`  addr     : ${addr}`);
    console.log(`  reason   : ${reason}`);
    if (events.length > 0) {
      console.log('  events   :');
      for (const ev of events) console.log(`    ${ev}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
