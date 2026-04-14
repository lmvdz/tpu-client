import { describe, it, expect } from 'vitest';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
import { CryptoError } from '@matrixai/quic/native/types.js';
import {
  extractEd25519PubkeyFromCert,
  evaluatePinDecision,
} from '../../src/quic-sender.js';
import { buildIdentity } from '../../src/identity.js';
import type { Address } from '@solana/kit';
import type { TpuEvent } from '../../src/events.js';

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

describe('evaluatePinDecision', () => {
  const FAKE_IDENTITY = 'A111111111111111111111111111111111111111111' as Address;

  async function matchingCertFor(pubkey: Uint8Array): Promise<Uint8Array> {
    // Build a cert whose SPKI equals `pubkey`. We can't easily craft one from
    // an arbitrary raw key, so instead we mint a fresh identity and use ITS
    // cert + pubkey together.
    const id = await buildIdentity();
    pubkey.set(id.pubkeyRaw);
    return id.certDer;
  }

  it('off: accepts any cert without emitting', async () => {
    const events: TpuEvent[] = [];
    const identity = await buildIdentity();
    const wrong = new Uint8Array(32).fill(0xff);
    const decision = evaluatePinDecision({
      certs: [identity.certDer],
      expectedPubkey: wrong,
      identity: FAKE_IDENTITY,
      pinMode: 'off',
      emit: (e) => events.push(e),
    });
    expect(decision).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('observe: accepts on mismatch but emits cert-pin-mismatch', async () => {
    const events: TpuEvent[] = [];
    const identity = await buildIdentity();
    const wrong = new Uint8Array(32).fill(0xff);
    const decision = evaluatePinDecision({
      certs: [identity.certDer],
      expectedPubkey: wrong,
      identity: FAKE_IDENTITY,
      pinMode: 'observe',
      emit: (e) => events.push(e),
    });
    expect(decision).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('cert-pin-mismatch');
  });

  it('strict: rejects on mismatch AND emits event', async () => {
    const events: TpuEvent[] = [];
    const identity = await buildIdentity();
    const wrong = new Uint8Array(32).fill(0xff);
    const decision = evaluatePinDecision({
      certs: [identity.certDer],
      expectedPubkey: wrong,
      identity: FAKE_IDENTITY,
      pinMode: 'strict',
      emit: (e) => events.push(e),
    });
    expect(decision).toBe(CryptoError.BadCertificate);
    expect(events).toHaveLength(1);
  });

  it('strict: accepts on match, no event', async () => {
    const events: TpuEvent[] = [];
    const pubkey = new Uint8Array(32);
    const cert = await matchingCertFor(pubkey);
    const decision = evaluatePinDecision({
      certs: [cert],
      expectedPubkey: pubkey,
      identity: FAKE_IDENTITY,
      pinMode: 'strict',
      emit: (e) => events.push(e),
    });
    expect(decision).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('observe: accepts on match, no event', async () => {
    const events: TpuEvent[] = [];
    const pubkey = new Uint8Array(32);
    const cert = await matchingCertFor(pubkey);
    const decision = evaluatePinDecision({
      certs: [cert],
      expectedPubkey: pubkey,
      identity: FAKE_IDENTITY,
      pinMode: 'observe',
      emit: (e) => events.push(e),
    });
    expect(decision).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('strict: rejects when no cert presented', () => {
    const events: TpuEvent[] = [];
    const decision = evaluatePinDecision({
      certs: [],
      expectedPubkey: new Uint8Array(32),
      identity: FAKE_IDENTITY,
      pinMode: 'strict',
      emit: (e) => events.push(e),
    });
    expect(decision).toBe(CryptoError.BadCertificate);
  });

  it('observe: rejects when no cert presented (protocol violation, not benign)', () => {
    const events: TpuEvent[] = [];
    const decision = evaluatePinDecision({
      certs: [],
      expectedPubkey: new Uint8Array(32),
      identity: FAKE_IDENTITY,
      pinMode: 'observe',
      emit: (e) => events.push(e),
    });
    expect(decision).toBe(CryptoError.BadCertificate);
  });

  it('strict: rejects unparseable cert', () => {
    const events: TpuEvent[] = [];
    const decision = evaluatePinDecision({
      certs: [new Uint8Array([0x00, 0x01])],
      expectedPubkey: new Uint8Array(32),
      identity: FAKE_IDENTITY,
      pinMode: 'strict',
      emit: (e) => events.push(e),
    });
    expect(decision).toBe(CryptoError.BadCertificate);
  });
});
