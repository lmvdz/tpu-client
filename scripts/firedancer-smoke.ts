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
 * Firedancer version heuristic (verified empirically against mainnet-beta, April 2026):
 *   - Agave validators report versions starting with "2." or "3." (e.g. "3.1.13", "2.2.x").
 *   - Frankendancer reports versions with a leading "0." — e.g. "0.820.30113". The first
 *     segment is "0", the second is the Frankendancer release series (e.g. 820), the third
 *     is the build number.
 *   - Full Firedancer (pure, no Agave runtime) is rolling out and may use the same
 *     "0.xxx.xxxxx" scheme; we treat any "0." prefix as a Firedancer variant.
 *   - We also retain the legacy substring checks ("firedancer", "frankendancer", "fd\d")
 *     in case older or dev builds emit them.
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
  // Primary signal: Frankendancer/Firedancer use 0.xxx.xxxxx (Agave uses 2.x/3.x).
  if (/^0\.\d+\.\d+/.test(v)) return true;
  // Legacy / dev-build labels.
  return (
    v.includes('firedancer') ||
    v.includes('frankendancer') ||
    /^fd\d/.test(v)
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ProbeResult {
  label: string;
  identity: string;
  addr: string;
  version: string | null;
  ok: boolean;
  reason?: string;
  expectedPubkey?: string;
  gotPubkey?: string;
}

async function probe(
  label: string,
  identity: Address,
  addr: string,
  version: string | null,
): Promise<ProbeResult> {
  const tpuIdentity = await buildIdentity(undefined);
  const events: string[] = [];
  const emit = (e: { type: string; [k: string]: unknown }): void => {
    events.push(JSON.stringify(e));
  };
  try {
    const conn = await openTpuQuicConn({
      identity,
      addr,
      maxStreams: 1,
      tpuIdentity,
      emit,
    });
    await conn.destroy('smoke-done');
    return { label, identity: String(identity), addr, version, ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const pinEvent = events
      .map((e) => JSON.parse(e))
      .find((e) => e.type === 'cert-pin-mismatch');
    return {
      label,
      identity: String(identity),
      addr,
      version,
      ok: false,
      reason,
      ...(pinEvent && {
        expectedPubkey: pinEvent.expected,
        gotPubkey: pinEvent.got,
      }),
    };
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
  console.log(`RPC: ${rpcUrl}`);

  const rpc = createSolanaRpc(rpcUrl);

  console.log('Fetching cluster nodes...');
  const nodes = await rpc.getClusterNodes().send();
  console.log(`Total nodes: ${nodes.length}`);

  const agaveNodes = nodes.filter(
    (n) => n.tpuQuic != null && !isFiredancerVersion(n.version) && n.version != null,
  );
  const fdNodes = nodes.filter(
    (n) => n.tpuQuic != null && isFiredancerVersion(n.version),
  );

  console.log(`Agave candidates      : ${agaveNodes.length}`);
  console.log(`Firedancer candidates : ${fdNodes.length}`);

  if (agaveNodes.length === 0 || fdNodes.length === 0) {
    console.log('Insufficient candidates for comparative probe.');
    process.exit(1);
  }

  // Probe up to 3 of each to rule out per-node quirks.
  const results: ProbeResult[] = [];
  for (const n of agaveNodes.slice(0, 3)) {
    const r = await probe('agave', n.pubkey as Address, n.tpuQuic!, n.version);
    results.push(r);
  }
  for (const n of fdNodes.slice(0, 3)) {
    const r = await probe('frankendancer', n.pubkey as Address, n.tpuQuic!, n.version);
    results.push(r);
  }

  console.log('\n=== RESULTS ===');
  for (const r of results) {
    console.log(`\n[${r.label}] ${r.identity}  (${r.version})`);
    console.log(`  addr : ${r.addr}`);
    console.log(`  ok   : ${r.ok}`);
    if (!r.ok) {
      console.log(`  why  : ${r.reason}`);
      if (r.expectedPubkey) {
        console.log(`  expected SPKI pubkey : ${r.expectedPubkey}`);
        console.log(`  got SPKI pubkey      : ${r.gotPubkey}`);
      }
    }
  }

  // Summary diagnosis
  const agaveOk = results.filter((r) => r.label === 'agave' && r.ok).length;
  const fdOk = results.filter((r) => r.label === 'frankendancer' && r.ok).length;
  console.log('\n=== DIAGNOSIS ===');
  console.log(`Agave pin success        : ${agaveOk}/3`);
  console.log(`Frankendancer pin success: ${fdOk}/3`);
  if (agaveOk === 0 && fdOk === 0) {
    console.log(
      'Neither Agave nor Frankendancer present a cert whose SPKI matches the gossip identity.',
    );
    console.log(
      'Conclusion: server cert pubkey != validator identity on Solana TPU QUIC.',
    );
    console.log(
      'Action: relax pinning to "present cert, accept all" (match prior v1 behavior) OR',
    );
    console.log(
      'investigate whether Solana uses a different pinning scheme (e.g., per-connection cert).',
    );
  } else if (agaveOk > 0 && fdOk === 0) {
    console.log('Agave pins correctly; Frankendancer uses a different scheme.');
  } else if (agaveOk > 0 && fdOk > 0) {
    console.log('Both accept our pin. The original failure may be a stale node.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
