# 04 — Research: resolve DESIGN.md open questions

STATUS: open
PRIORITY: p0 (blocks concerns 09, 10, 12)
COMPLEXITY: research
BLOCKED_BY: 01 (VERIFY: `test -f package.json`)
TOUCHES: plans/kit-v3-rewrite/NOTES-04.md (new)

## Goal
Resolve four open questions from DESIGN.md before the modules that depend on them are implemented. Produce a concrete `NOTES-04.md` with API signatures, code snippets, and test vectors that downstream implementers can copy.

## Questions to answer

### Q1: `@matrixai/quic` `verifyCallback` signature

Check the currently-published `@matrixai/quic` version on npm (latest stable). Determine:
- Exact option name (`verifyCallback`, `verifyPeerCertificate`, `verify`?).
- Signature — sync or async? What arguments (DER Buffer chain, parsed X509?, SNI?)?
- How to fail verification — throw, return false, return a specific type?
- Is there a `verifyPeer: false` mode that still calls `verifyCallback`? (We want cert presented and pinned — not skipped.)
- Can ALPN be asserted (`applicationProtos`) in the same config? Name may differ.

**Deliverable**: working code stub.

```ts
const client = await QUICClient.createQUICClient({
  host, port,
  config: {
    applicationProtos: ['solana-tpu'],
    verifyCallback: async (certDerChain: Uint8Array[]) => { /* ... */ },
    // other required fields with defaults
  },
});
```

Read the published README/types. If not publicly documented, read the installed `.d.ts` from `node_modules` after a temp install in a scratch dir.

### Q2: SPKI Ed25519 extraction from Solana validator X.509

Validators self-sign an X.509 where the public key is their Ed25519 identity key. Using `@peculiar/x509`:
- Parse DER: `new x509.X509Certificate(der)`.
- Access SPKI: `.publicKey.rawData` returns SPKI DER (AlgorithmIdentifier + BIT STRING).
- For Ed25519, the raw 32-byte public key is the last 32 bytes of SPKI (OID 1.3.101.112 algorithm).

**Deliverable**: a helper + a real-validator test vector.

```ts
export function extractEd25519PubkeyFromCert(der: Uint8Array): Uint8Array {
  const cert = new x509.X509Certificate(der);
  const spki = new Uint8Array(cert.publicKey.rawData);
  // Ed25519 SPKI is always 44 bytes (12-byte prefix + 32-byte key).
  if (spki.length !== 44) throw new Error(`unexpected SPKI length ${spki.length}`);
  return spki.slice(12);
}
```

**Test vector**: capture a real TPU-QUIC cert from mainnet-beta by connecting to any advertised `tpu_quic` endpoint via `openssl s_client -connect host:port -alpn solana-tpu` (or Node snippet with QUIC lib). Paste hex DER + expected 32-byte pubkey into NOTES-04.md. If unable to capture live, cite docs + flag as needs-verification-at-impl.

### Q3: Firedancer ALPN / cert empirical check

Best-effort: connect to a known Firedancer validator's TPU-QUIC endpoint (identify one via `getClusterNodes` on mainnet, cross-referencing known Firedancer operators per the research agent's BlockEden source). Record:
- Does connection succeed with `applicationProtos: ['solana-tpu']`?
- What's the cert structure — same Ed25519 SPKI pattern as Agave?
- Any TLS extension differences visible via `openssl s_client -alpn solana-tpu -msg`?

If unable to identify a live Firedancer node, note this as a manual smoke-test item for post-implementation.

### Q4: kit 3.x `Commitment` type

Find the canonical commitment type export. Likely:
```ts
import type { Commitment } from '@solana/rpc-types';
// or
import type { Commitment } from '@solana/kit';
```

Check kit 3.0.3 source / `node_modules/@solana/kit/package.json` `exports` to find the correct import path. Decide whether `confirm.ts` should import it or define a local literal union `'processed' | 'confirmed' | 'finalized'`.

## Approach

1. Create a scratch directory (`mktemp -d`), `npm init -y`, `npm i @solana/kit@latest @matrixai/quic@latest @peculiar/x509@latest` to inspect real types.
2. Use `Glob`/`Read` on the installed `.d.ts` files to get authoritative signatures.
3. For Q3, use `curl` / `openssl s_client` if a Firedancer node can be identified; otherwise document as pending.
4. Write findings to `plans/kit-v3-rewrite/NOTES-04.md` with code-ready snippets.

## Deliverable structure for NOTES-04.md

```markdown
# NOTES-04 — research results

## Q1: @matrixai/quic verifyCallback
Version: <x.y.z>
Signature: ...
Code stub: ...

## Q2: SPKI extraction
Helper: ...
Test vector: ...  (or: needs live capture — do in concern 10 integration test)

## Q3: Firedancer
Status: <verified | pending — manual smoke test required>

## Q4: Commitment
Import: ...
```

## Verify

```bash
test -f plans/kit-v3-rewrite/NOTES-04.md
grep -q "verifyCallback" plans/kit-v3-rewrite/NOTES-04.md
grep -q "extractEd25519PubkeyFromCert\|SPKI" plans/kit-v3-rewrite/NOTES-04.md
```

## Anomaly handling

If research reveals `@matrixai/quic` current version has NO way to hook cert verification (i.e., you cannot pin) — STOP and report. This invalidates a core design decision and needs escalation (possible remediations: fork the lib, use a Rust NAPI binding, or accept the MITM risk explicitly).
