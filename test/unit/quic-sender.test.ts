import { describe, it, expect } from 'vitest';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
import { extractEd25519PubkeyFromCert } from '../../src/quic-sender.js';
import { buildIdentity } from '../../src/identity.js';

// Register @peculiar/x509's crypto provider (same as identity.ts does)
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

describe('extractEd25519PubkeyFromCert', () => {
  it('extracts pubkey from valid cert and matches identity.pubkeyRaw', async () => {
    const identity = await buildIdentity();
    const extracted = extractEd25519PubkeyFromCert(identity.certDer);
    expect(extracted).toBeInstanceOf(Uint8Array);
    expect(extracted.length).toBe(32);
    expect(extracted).toEqual(identity.pubkeyRaw);
  });

  it('throws on truncated/invalid DER', () => {
    const truncated = new Uint8Array([0x30, 0x05, 0x01, 0x02, 0x03]);
    expect(() => extractEd25519PubkeyFromCert(truncated)).toThrow();
  });
});
