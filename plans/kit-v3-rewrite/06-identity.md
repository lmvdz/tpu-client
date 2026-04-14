# 06 — identity.ts

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/identity.ts

## Goal
Produce a self-signed X.509 leaf certificate presenting the user's Ed25519 identity public key as SPKI. This cert is what validators read to apply stake-weighted QoS (the client-side QoS identity equals the cert's SPKI pubkey).

If no identity is supplied, generate an ephemeral Ed25519 keypair + cert and warn (ephemeral = unstaked = first-dropped under load).

## Approach

```ts
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';

// @peculiar/x509 needs a WebCrypto provider registered.
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface TpuIdentity {
  /** Ed25519 keypair used as QoS identity. */
  readonly keyPair: CryptoKeyPair;
  /** Self-signed DER-encoded X.509 cert for TLS ClientHello. */
  readonly certDer: Uint8Array;
  /** Identity pubkey in raw 32 bytes (for logging and diagnostics). */
  readonly pubkeyRaw: Uint8Array;
  /** True if this was generated ephemerally (no user-supplied key). */
  readonly ephemeral: boolean;
}

export async function buildIdentity(supplied?: CryptoKeyPair): Promise<TpuIdentity> {
  const ephemeral = !supplied;
  const keyPair = supplied ?? await generateEd25519();

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: 'CN=Solana',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    signingAlgorithm: { name: 'Ed25519' },
    keys: keyPair,
    extensions: [
      new x509.BasicConstraintsExtension(false),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
      ),
    ],
  });

  const certDer = new Uint8Array(cert.rawData);
  const pubkeyRaw = await exportRawEd25519Pubkey(keyPair.publicKey);
  return { keyPair, certDer, pubkeyRaw, ephemeral };
}

async function generateEd25519(): Promise<CryptoKeyPair> {
  return await webcrypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
}

async function exportRawEd25519Pubkey(key: CryptoKey): Promise<Uint8Array> {
  // SPKI export → 44 bytes. Raw Ed25519 key is the last 32.
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', key));
  if (spki.length !== 44) throw new Error(`unexpected SPKI length ${spki.length}`);
  return spki.slice(12);
}

function randomSerial(): string {
  const bytes = webcrypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Helper for users who have a 64-byte Ed25519 secret (32 seed + 32 pub) from solana CLI. */
export async function ed25519KeyPairFromSeed(seed32: Uint8Array): Promise<CryptoKeyPair> {
  if (seed32.length !== 32) throw new Error('seed must be 32 bytes');
  const pkcs8 = buildEd25519Pkcs8(seed32);
  const privateKey = await webcrypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'],
  );
  // Derive public via SPKI export from private — WebCrypto doesn't give it directly,
  // but we can compute via @peculiar/x509's subtle replay, or require the caller to
  // pass a 64-byte full secret. Simpler: import the matching jwk with both d and x.
  // (Implementer: choose the approach that works on Node 22 WebCrypto. See NOTES-04 if needed.)
  throw new Error('implement after verifying Node 22 WebCrypto Ed25519 JWK support');
}
```

## Decisions

- **Library**: `@peculiar/x509` is the only option. `node:crypto.X509Certificate` parses but cannot mint X.509. `selfsigned` is RSA-only.
- **Validity**: 1 year. Long enough that long-lived services don't churn, short enough for auditors.
- **KeyUsage**: `digitalSignature | keyEncipherment` (matches Agave's client cert template).
- **Subject**: `CN=Solana` (Firedancer is strict about ALPN, not subject — but match Agave's convention).
- **Seed helper**: provide `ed25519KeyPairFromSeed` scaffolding but mark as "implement once verified on Node 22". The main path takes a ready `CryptoKeyPair`. Users typically run `solana-keygen` → 64-byte file; recipe in README.

## Verify

```bash
npx tsc --noEmit
# Quick smoke (integration-style), can run manually during impl:
npx tsx -e "import('./lib/identity.js').then(async m => { const id = await m.buildIdentity(); console.log('pubkey:', Buffer.from(id.pubkeyRaw).toString('hex'), 'der bytes:', id.certDer.length); })"
```

Expected: 32-byte hex pubkey, cert DER ~200-400 bytes.

Concern 14 adds a unit test: build identity twice with the same keypair, assert same `pubkeyRaw`; build ephemerally, assert `ephemeral: true` and unique pubkey per call.
