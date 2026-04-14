import { describe, it, expect } from 'vitest';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
import { buildIdentity, ed25519KeyPairFromSeed, ed25519KeyPairFromSolanaSecret } from '../../src/identity.js';

// Register @peculiar/x509's crypto provider (same as identity.ts does)
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

describe('buildIdentity', () => {
  it('no arg → ephemeral=true, pubkeyRaw is 32 bytes, certDer is non-empty', async () => {
    const id = await buildIdentity();
    expect(id.ephemeral).toBe(true);
    expect(id.pubkeyRaw).toBeInstanceOf(Uint8Array);
    expect(id.pubkeyRaw.length).toBe(32);
    expect(id.certDer).toBeInstanceOf(Uint8Array);
    expect(id.certDer.length).toBeGreaterThan(0);
  });

  it('with keypair → ephemeral=false, pubkeyRaw matches exported SPKI[12:]', async () => {
    const keyPair = (await webcrypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;

    const id = await buildIdentity(keyPair);
    expect(id.ephemeral).toBe(false);

    // Export SPKI and take bytes 12..44
    const spkiBytes = new Uint8Array(
      await webcrypto.subtle.exportKey('spki', keyPair.publicKey),
    );
    const expectedRaw = spkiBytes.slice(12);
    expect(id.pubkeyRaw).toEqual(expectedRaw);
  });

  it('cert roundtrip: parse certDer with @peculiar/x509, SPKI[12:] matches pubkeyRaw', async () => {
    const id = await buildIdentity();

    // Parse the cert
    const cert = new x509.X509Certificate(id.certDer);

    // The cert's subjectPublicKeyInfo is the SPKI bytes.
    // publicKey.rawData is the SubjectPublicKeyInfo SEQUENCE (SPKI), so bytes 12+ are the raw key.
    const spkiBytes = new Uint8Array(cert.publicKey.rawData);
    // SPKI for Ed25519 is 44 bytes; raw pubkey is last 32
    const extractedRaw = spkiBytes.slice(12);

    expect(extractedRaw).toEqual(id.pubkeyRaw);
  });
});

describe('ed25519KeyPairFromSeed', () => {
  it('returns a keypair with a 32-byte public key from a 32-byte seed', async () => {
    const seed = webcrypto.getRandomValues(new Uint8Array(32));
    const kp = await ed25519KeyPairFromSeed(seed);
    const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', kp.publicKey));
    // SPKI for Ed25519 is 44 bytes; raw pubkey is last 32
    expect(spki.length).toBe(44);
    const pubRaw = spki.slice(12);
    expect(pubRaw.length).toBe(32);
  });

  it('throws on invalid seed length', async () => {
    await expect(ed25519KeyPairFromSeed(new Uint8Array(16))).rejects.toThrow('32 bytes');
    await expect(ed25519KeyPairFromSeed(new Uint8Array(64))).rejects.toThrow('32 bytes');
  });
});

describe('ed25519KeyPairFromSolanaSecret', () => {
  it('imports a 64-byte Solana secret key correctly', async () => {
    // Generate a real keypair first
    const original = (await webcrypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;

    // Export the public key raw
    const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', original.publicKey));
    const pubRaw = spki.slice(12); // 32 bytes

    // Get the seed from PKCS8
    const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', original.privateKey));
    // PKCS8 for Ed25519: last 32 bytes are the seed
    const seed = pkcs8.slice(pkcs8.length - 32);

    // Build the 64-byte Solana secret key
    const solanaSecret = new Uint8Array(64);
    solanaSecret.set(seed, 0);
    solanaSecret.set(pubRaw, 32);

    const imported = await ed25519KeyPairFromSolanaSecret(solanaSecret);

    // Verify the public key matches
    const importedSpki = new Uint8Array(await webcrypto.subtle.exportKey('spki', imported.publicKey));
    const importedPubRaw = importedSpki.slice(12);
    expect(importedPubRaw).toEqual(pubRaw);
  });

  it('throws on wrong length', async () => {
    await expect(ed25519KeyPairFromSolanaSecret(new Uint8Array(32))).rejects.toThrow('64 bytes');
  });
});
