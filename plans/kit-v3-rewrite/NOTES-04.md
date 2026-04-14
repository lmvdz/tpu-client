# NOTES-04 — research results

Scratch install performed in `/tmp/tmp.aOakliyJ50` with:
- `@matrixai/quic@2.0.9`
- `@peculiar/x509@1.x` (installed from `latest`)
- `@solana/kit@3.0.x` — NOTE: `npm i @solana/kit@latest` resolved to `6.8.0` in this sandbox (the published `latest` dist-tag is ahead of the plan's "3.0.3" assumption). The re-export path below is stable across 3.x → 6.x.

---

## Q1: `@matrixai/quic` verifyCallback — CONFIRMED (confidence: HIGH)

Authoritative source: `node_modules/@matrixai/quic/dist/types.d.ts` and `dist/native/types.d.ts`.

### Signature

```ts
// From @matrixai/quic/dist/types.d.ts:82
type TLSVerifyCallback = (
  certs: Array<Uint8Array>,   // peer cert chain, DER-encoded, leaf first
  ca: Array<Uint8Array>,      // configured CA DERs (empty array if none)
) => PromiseLike<CryptoError | undefined>;
```

- **Option name**: `verifyCallback` (on `QUICConfig`).
- **Async**: returns `PromiseLike` — `async` functions work.
- **Pass**: return `undefined` (or resolved promise of `undefined`).
- **Fail**: return a `CryptoError` enum value (from `@matrixai/quic/dist/native/types.d.ts`). Relevant codes:
  - `BadCertificate = 298`
  - `UnsupportedCertificate = 299`
  - `CertificateUnknown = 302`
  - `UnknownCA = 304`
  - `AccessDenied = 305`
  - `HandshakeFailure = 296`
  For pubkey-pin mismatch, `BadCertificate` (298) or `AccessDenied` (305) are the most semantically correct. Use `BadCertificate`.
- **Throwing**: the docstring at `types.d.ts:141` says "It is expected that the callback will throw an error if the verification fails." The **implementation** (`QUICConnection.js:674`) simply `await`s the callback and uses its return value; throwing will reject up the handshake promise. Safer and clearer: return a `CryptoError` code; it is the documented type-level contract.

### Interaction with `verifyPeer`

From `types.d.ts:138-145` and `config.js:122`:
- `verifyPeer` must be `true` for `verifyCallback` to be invoked. If `verifyPeer: false`, the callback is **ignored**.
- Internally it calls `quiche.Config.withBoringSslCtx(verifyPeer, verifyCallback != null, ca, key, cert, sigalgs)`. The 2nd arg (`verifyAllowFail`) is set when `verifyCallback != null`, which lets BoringSSL pass the cert chain up even when it wouldn't normally verify (e.g. self-signed validator identity certs). **This is exactly what we need for TPU: validators self-sign, so BoringSSL path-building will fail; the callback is what actually accepts/rejects.**
- Recommended: `verifyPeer: true`, `ca: undefined`, `verifyCallback: ourPinCheck`. This gives us the cert chain but lets us decide.

### ALPN

Option name: `applicationProtos: string[]` (plural). Default is `['quic']`. Set to `['solana-tpu']`.

Failure mode: if the server does not advertise `solana-tpu`, the handshake will abort with `CryptoError.NoApplicationProtocol = 376`.

### Copy-paste stub for concern 10

```ts
import { QUICClient } from '@matrixai/quic';
import { CryptoError } from '@matrixai/quic/dist/native/types.js';
import * as webcrypto from 'node:crypto';

// Minimal client crypto — @matrixai/quic needs random bytes for connection IDs.
const clientCrypto = {
  ops: {
    randomBytes: async (n: number) => {
      const b = webcrypto.randomBytes(n);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  },
};

const client = await QUICClient.createQUICClient({
  host,
  port,
  crypto: clientCrypto,
  config: {
    verifyPeer: true,
    applicationProtos: ['solana-tpu'],
    verifyCallback: async (certs, _ca) => {
      if (certs.length === 0) return CryptoError.BadCertificate;
      const leaf = certs[0];
      const pubkey = extractEd25519PubkeyFromCert(leaf); // see Q2
      if (!constantTimeEquals(pubkey, expectedIdentityPubkey)) {
        return CryptoError.BadCertificate;
      }
      return undefined; // pass
    },
    // All other QUICConfig fields have defaults via clientDefault.
  },
});
```

Note: `QUICClientConfigInput` is a `Partial<QUICConfig>` — you only need to set fields you want to override. `verifyPeer` defaults to `true` on clients but set explicitly for clarity.

---

## Q2: SPKI Ed25519 extraction — CONFIRMED (confidence: HIGH for helper; MED for test vector)

Authoritative source: `node_modules/@peculiar/x509/build/index.d.ts` — `PublicKey` extends `PemData<SubjectPublicKeyInfo>` with `get rawData(): ArrayBuffer` (line 78), and `X509Certificate.publicKey: PublicKey` (line 1257).

### Helper

```ts
import * as x509 from '@peculiar/x509';

/**
 * Extract the raw 32-byte Ed25519 public key from a Solana validator's
 * self-signed X.509 cert (DER).
 *
 * Ed25519 SPKI (RFC 8410) is always 44 bytes:
 *   30 2a              SEQUENCE (42 bytes)
 *     30 05            SEQUENCE (5 bytes)  AlgorithmIdentifier
 *       06 03 2b 65 70 OID 1.3.101.112 (Ed25519)
 *     03 21 00         BIT STRING (33 bytes, 0 unused)
 *       <32-byte pubkey>
 *
 * The last 32 bytes of SPKI DER are the raw public key.
 */
export function extractEd25519PubkeyFromCert(der: Uint8Array): Uint8Array {
  const cert = new x509.X509Certificate(der);
  const spki = new Uint8Array(cert.publicKey.rawData);
  if (spki.length !== 44) {
    throw new Error(`unexpected SPKI length ${spki.length}, expected 44 for Ed25519`);
  }
  // Optional defense-in-depth: verify OID bytes at offsets 6..11 = 06 03 2b 65 70.
  if (
    spki[4] !== 0x06 || spki[5] !== 0x03 ||
    spki[6] !== 0x2b || spki[7] !== 0x65 || spki[8] !== 0x70
  ) {
    throw new Error('SPKI algorithm OID is not Ed25519 (1.3.101.112)');
  }
  return spki.slice(12);
}
```

### Test vector

**Status**: PENDING live capture. No live validator endpoint was queried in this research pass. Acquire in concern 10 integration test. Procedure:

1. `curl https://api.mainnet-beta.solana.com -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getClusterNodes"}' | jq '.result[] | select(.tpuQuic) | {pubkey, tpuQuic}' | head`
2. Open a QUIC connection with `verifyPeer: true, verifyCallback: (certs) => { console.log(Buffer.from(certs[0]).toString('hex')); return undefined; }` to capture the DER.
3. Assert `bs58.encode(extractEd25519PubkeyFromCert(der)) === node.pubkey`.

Paste hex + expected pubkey into this section once captured.

---

## Q3: Firedancer ALPN / cert — PENDING manual smoke test

Not resolved in this research pass. Action item for post-implementation:

- Identify a mainnet Firedancer node via `getClusterNodes` cross-referenced with known Firedancer operators (per DESIGN.md's BlockEden list). Firedancer nodes advertise a distinct `version` string (e.g. `"0.x"` vs Agave's `"2.x"`).
- Probe: `openssl s_client -alpn solana-tpu -msg -connect <host>:<tpuQuic>` — expect handshake, single self-signed cert.
- If Firedancer does not accept `solana-tpu` ALPN or uses a different cert shape, extractEd25519PubkeyFromCert may need a fallback path.

Prior art signal: Firedancer's public design docs reference `solana-tpu` ALPN compatibility; risk is low. Confidence: MED based on docs; HIGH only after smoke test.

---

## Q4: kit `Commitment` import — CONFIRMED (confidence: HIGH)

Authoritative source: `node_modules/@solana/rpc-types/dist/types/commitment.d.ts:7`:

```ts
export type Commitment = 'confirmed' | 'finalized' | 'processed';
```

`@solana/kit` re-exports all of `@solana/rpc-types` (see `node_modules/@solana/kit/dist/types/index.d.ts:24` — `export * from '@solana/rpc-types';`). Internal kit modules (e.g. `send-transaction-internal.d.ts`) import it as `import { Commitment } from '@solana/rpc-types'`.

### Recommendation for `confirm.ts`

```ts
import type { Commitment } from '@solana/kit';
```

Prefer the `@solana/kit` surface so this client has exactly one peer-dep entry. No need to add `@solana/rpc-types` as a direct dep. The type is trivially a string literal union, so a local fallback `type Commitment = 'processed' | 'confirmed' | 'finalized'` is safe if we want zero coupling — but since we already depend on kit for RPC, the re-export is the natural choice.

**Version note**: the plan mentions kit "3.0.3". `npm i @solana/kit@latest` in the scratch dir resolved to `6.8.0`. The re-export path is identical in both — but verify the `peerDependencies` version range in this repo's `package.json` matches the actual kit version pinned in concern 01.

---

## Summary table

| Q  | Status    | Confidence |
|----|-----------|------------|
| Q1 | Resolved  | HIGH       |
| Q2 | Helper resolved; test vector pending live capture | HIGH / MED |
| Q3 | Pending manual smoke test | LOW |
| Q4 | Resolved  | HIGH       |

No design-invalidating anomalies. `@matrixai/quic` supports cert pinning via `verifyCallback` + `verifyPeer: true` with `verifyAllowFail` auto-enabled when a callback is present — this is precisely the hook TPU pinning needs. Proceed with concerns 09, 10, 12.
