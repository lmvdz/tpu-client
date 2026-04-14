import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';

// Register @peculiar/x509's crypto provider once at module load.
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

/**
 * Build a TpuIdentity from an existing keypair, or generate an ephemeral one.
 * Ephemeral identities are unstaked — validators will drop their packets first
 * under load.
 */
export async function buildIdentity(supplied?: CryptoKeyPair): Promise<TpuIdentity> {
  const ephemeral = !supplied;
  // NOTE: no warning here — buildIdentity is a low-level utility that callers
  // (including smoke scripts and tests) legitimately invoke without wanting
  // a scary banner. The ephemeral-identity warning lives in createTpuClient.
  const keyPair = supplied ?? (await generateEd25519());

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

/**
 * Import an Ed25519 keypair from a 32-byte seed.
 *
 * Uses the minimal PKCS#8 wrapper for Ed25519:
 *   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32-byte seed>
 * then re-exports the private key as JWK to obtain the derived public key.
 */
export async function ed25519KeyPairFromSeed(seed32: Uint8Array): Promise<CryptoKeyPair> {
  if (seed32.length !== 32) throw new Error('seed must be 32 bytes');

  const pkcs8 = buildEd25519Pkcs8(seed32);
  const privateKey = await webcrypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true, // must be extractable to re-export as JWK for the public component
    ['sign'],
  );

  // Re-export as JWK: Node WebCrypto includes `x` (public key) in the private JWK.
  const jwk = await webcrypto.subtle.exportKey('jwk', privateKey);
  if (!jwk.x) throw new Error('JWK export did not include public key component (x)');

  const publicKey = await webcrypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );

  return { privateKey, publicKey };
}

/**
 * Import an Ed25519 keypair from a 64-byte Solana secret key file
 * (32-byte seed concatenated with 32-byte public key, as produced by solana-keygen).
 *
 * The private key is imported from the seed (first 32 bytes) and the public key
 * is imported directly from the trailing 32 bytes via SPKI wrapper.
 */
export async function ed25519KeyPairFromSolanaSecret(secret64: Uint8Array): Promise<CryptoKeyPair> {
  if (secret64.length !== 64) throw new Error('Solana secret key must be 64 bytes');

  const seed = secret64.slice(0, 32);
  const pubBytes = secret64.slice(32, 64);

  const pkcs8 = buildEd25519Pkcs8(seed);
  const privateKey = await webcrypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );

  // Import public key directly from the known bytes via SPKI wrapper.
  const spki = buildEd25519Spki(pubBytes);
  const publicKey = await webcrypto.subtle.importKey(
    'spki',
    spki,
    { name: 'Ed25519' },
    true,
    ['verify'],
  );

  return { privateKey, publicKey };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function generateEd25519(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

async function exportRawEd25519Pubkey(key: CryptoKey): Promise<Uint8Array> {
  // SPKI export for Ed25519 is always 44 bytes; raw pubkey is the last 32.
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', key));
  if (spki.length !== 44) throw new Error(`unexpected SPKI length ${spki.length}, expected 44`);
  return spki.slice(12);
}

/**
 * Construct a minimal PKCS#8 wrapper for a 32-byte Ed25519 seed.
 *
 * Structure (RFC 8410 §7):
 *   30 2e                SEQUENCE (46 bytes)
 *     02 01 00           INTEGER version = 0
 *     30 05              SEQUENCE AlgorithmIdentifier (5 bytes)
 *       06 03 2b 65 70   OID 1.3.101.112 (Ed25519)
 *     04 22              OCTET STRING (34 bytes)
 *       04 20            OCTET STRING (32 bytes) — the seed
 *         <32-byte seed>
 */
function buildEd25519Pkcs8(seed32: Uint8Array): Uint8Array {
  // prettier-ignore
  const header = new Uint8Array([
    0x30, 0x2e,           // SEQUENCE (46 bytes total)
    0x02, 0x01, 0x00,     // INTEGER 0 (version)
    0x30, 0x05,           // SEQUENCE (5 bytes) AlgorithmIdentifier
      0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112
    0x04, 0x22,           // OCTET STRING (34 bytes)
      0x04, 0x20,         // OCTET STRING (32 bytes) — CurvePrivateKey
  ]);
  const pkcs8 = new Uint8Array(header.length + 32);
  pkcs8.set(header);
  pkcs8.set(seed32, header.length);
  return pkcs8;
}

/**
 * Construct a minimal SPKI wrapper for a 32-byte Ed25519 public key.
 *
 * Structure (RFC 8410):
 *   30 2a              SEQUENCE (42 bytes)
 *     30 05            SEQUENCE AlgorithmIdentifier (5 bytes)
 *       06 03 2b 65 70 OID 1.3.101.112 (Ed25519)
 *     03 21 00         BIT STRING (33 bytes, 0 unused bits)
 *       <32-byte pubkey>
 */
function buildEd25519Spki(pub32: Uint8Array): Uint8Array {
  // prettier-ignore
  const header = new Uint8Array([
    0x30, 0x2a,           // SEQUENCE (42 bytes)
    0x30, 0x05,           // SEQUENCE AlgorithmIdentifier
      0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112
    0x03, 0x21, 0x00,     // BIT STRING, 33 bytes, 0 unused
  ]);
  const spki = new Uint8Array(header.length + 32);
  spki.set(header);
  spki.set(pub32, header.length);
  return spki;
}

function randomSerial(): string {
  const bytes = webcrypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
