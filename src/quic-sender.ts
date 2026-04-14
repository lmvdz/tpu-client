/**
 * quic-sender.ts — Transport adapter over @matrixai/quic 2.x
 *
 * Opens a QUIC connection with:
 *   - ALPN = 'solana-tpu' (mandatory for Firedancer)
 *   - Server cert pinning via verifyCallback (SPKI Ed25519 pubkey vs. leader identity)
 *   - Client cert for stake-weighted QoS (user identity, PEM-encoded for @matrixai/quic)
 */

import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { getAddressEncoder } from '@solana/kit';
import { QUICClient } from '@matrixai/quic';
import { CryptoError } from '@matrixai/quic/native/types.js';
import Logger, { LogLevel } from '@matrixai/logger';
import type { Address } from '@solana/kit';
import type { QUICClientCrypto } from '@matrixai/quic';
import { parseHostPort } from './addr.js';
import type { TpuIdentity } from './identity.js';
import type { QuicConnection, PoolEntry } from './quic-pool.js';
import type { EventEmitter } from './events.js';
import type { TpuError } from './errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 2_000;
const DESTROY_TIMEOUT_MS = 2_000;

// Silent logger passed to every QUICClient — @matrixai/quic defaults to INFO
// which floods stdout with connection lifecycle messages. Library consumers
// should observe via TpuEvent, not scraped stdout.
const SILENT_LOGGER = new Logger('tpu-client', LogLevel.SILENT);

// ---------------------------------------------------------------------------
// Crypto provider — fills an ArrayBuffer in-place (ClientCryptoOps contract)
// ---------------------------------------------------------------------------

const CLIENT_CRYPTO: QUICClientCrypto = {
  ops: {
    randomBytes: async (data: ArrayBuffer): Promise<void> => {
      webcrypto.getRandomValues(new Uint8Array(data));
    },
  },
};

// ---------------------------------------------------------------------------
// Symbol for internal QUICClient handle on QuicConnection
// ---------------------------------------------------------------------------

const INNER = Symbol('quic-client');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Server-cert pin enforcement mode.
 *
 *   - `'strict'`  — reject the connection if the server cert SPKI does not match the
 *                   gossip-advertised identity pubkey. Only safe in fleets you know
 *                   present identity-signed certs (pure Agave, no LBs).
 *   - `'observe'` — emit a `cert-pin-mismatch` TpuEvent on mismatch but accept the
 *                   connection. Default. Works against real mainnet in April 2026
 *                   where Frankendancer presents per-connection certs (SPKI !=
 *                   identity) and some Agave nodes sit behind load balancers.
 *   - `'off'`     — do not inspect server certs at all.
 *
 * Note: the client cert (your QoS identity) is ALWAYS presented on the QUIC
 * ClientHello regardless of pinMode, because validators use it for
 * stake-weighted QoS. `pinMode` only governs SERVER cert inspection. If you
 * need to suppress client-identity exposure, do not pass `identity` — use the
 * ephemeral default, which still presents a cert but with a throwaway keypair.
 */
export type PinMode = 'strict' | 'observe' | 'off';

export interface OpenArgs {
  /** Leader identity (base58 Address) — used for cert-pin check. */
  identity: Address;
  /** "host:port" string for the TPU-QUIC endpoint. */
  addr: string;
  /** Max number of concurrent streams on this connection. */
  maxStreams: number;
  /** User's TpuIdentity (self-signed cert + keypair) for QoS. */
  tpuIdentity: TpuIdentity;
  /** Event emitter for observability. */
  emit: EventEmitter;
  /** Cert-pin enforcement mode. Default: 'observe'. */
  pinMode?: PinMode;
}

// ---------------------------------------------------------------------------
// openTpuQuicConn
// ---------------------------------------------------------------------------

export async function openTpuQuicConn(args: OpenArgs): Promise<QuicConnection> {
  const { host, port } = parseHostPort(args.addr);
  const pinMode: PinMode = args.pinMode ?? 'observe';

  // Decode base58 Address → 32 raw bytes for pubkey pinning.
  // getAddressEncoder().encode() returns ReadonlyUint8Array; copy to a plain Uint8Array.
  const encoder = getAddressEncoder();
  const expectedPubkey: Uint8Array = new Uint8Array(encoder.encode(args.identity));

  // Use pre-computed PEM strings from TpuIdentity (computed once at buildIdentity time).
  // @matrixai/quic config.key / config.cert accept PEM (string | Uint8Array).
  const certPem = args.tpuIdentity.certPem;
  const keyPem = args.tpuIdentity.privateKeyPem;

  // `verifyPeer: true` is required for the client cert to be presented (QoS),
  // so even in `pinMode: 'off'` we install a permissive callback rather than
  // disabling peer verification.
  const verifyCallback = (
    certs: Array<Uint8Array>,
    _ca: Array<Uint8Array>,
  ): Promise<CryptoError | undefined> =>
    Promise.resolve(
      evaluatePinDecision({
        certs,
        expectedPubkey,
        identity: args.identity,
        pinMode,
        emit: args.emit,
      }),
    );

  const client = await withTimeout(
    CONNECT_TIMEOUT_MS,
    QUICClient.createQUICClient({
      host,
      port,
      crypto: CLIENT_CRYPTO,
      logger: SILENT_LOGGER,
      config: {
        // MANDATORY for Firedancer/Agave TPU — handshake fails without it.
        applicationProtos: ['solana-tpu'],
        // verifyPeer: true is the client default, but set explicitly for clarity.
        // When verifyCallback is non-null, @matrixai/quic sets verifyAllowFail=true
        // internally, so self-signed validator certs are forwarded to the callback
        // rather than rejected by BoringSSL path-building.
        verifyPeer: true,
        verifyCallback,
        // Client cert for stake-weighted QoS.
        // @matrixai/quic expects PEM (string | Uint8Array containing PEM text).
        cert: certPem,
        key: keyPem,
        // Agave default for TPU QUIC connections.
        initialMaxStreamsUni: args.maxStreams,
        maxIdleTimeout: 30_000,
      },
    }),
  );

  const conn: QuicConnection & { [INNER]: QUICClient } = {
    isOpen(): boolean {
      return !client.closed;
    },
    async destroy(_reason?: string): Promise<void> {
      // @matrixai/quic destroy() can hang past its own internal close if a
      // lingering stream or deferred send is still draining. Cap it at
      // DESTROY_TIMEOUT_MS — after that the process-level socket cleanup will
      // reclaim the fd; keeping callers waiting is worse.
      try {
        await withTimeout(DESTROY_TIMEOUT_MS, client.destroy({ force: true }));
      } catch {
        // Timeout or already-closed — either way, fire-and-forget.
      }
    },
    [INNER]: client,
  };

  return conn;
}

// ---------------------------------------------------------------------------
// sendOnce
// ---------------------------------------------------------------------------

export async function sendOnce(
  entry: PoolEntry,
  txBytes: Uint8Array,
  signal: AbortSignal,
): Promise<{ rttMs: number } | TpuError> {
  if (!entry.streamSlots.tryAcquire()) {
    return { kind: 'backpressure', identity: entry.identity };
  }
  const started = Date.now();
  let abortHandler: (() => void) | undefined;
  let stream: ReturnType<(typeof QUICClient.prototype.connection)['newStream']> | undefined;
  try {
    const client = (entry.conn as QuicConnection & { [INNER]: QUICClient })[INNER];
    stream = client.connection.newStream('uni');

    const writer = stream.writable.getWriter();
    abortHandler = () => {
      writer.abort('aborted').catch(() => {});
      stream?.cancel('aborted');
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    try {
      await withTimeout(WRITE_TIMEOUT_MS, (async () => {
        await writer.write(txBytes);
        await writer.close();
      })());
    } finally {
      if (abortHandler !== undefined) {
        signal.removeEventListener('abort', abortHandler);
      }
    }

    return { rttMs: Date.now() - started };
  } catch (err) {
    if (signal.aborted) return { kind: 'aborted' };
    const msg = String(err);
    if (/timeout/i.test(msg)) return { kind: 'write-timeout', identity: entry.identity };
    return { kind: 'transport', identity: entry.identity, cause: msg };
  } finally {
    entry.streamSlots.release();
  }
}

// ---------------------------------------------------------------------------
// extractEd25519PubkeyFromCert (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract the raw 32-byte Ed25519 public key from a DER-encoded X.509 cert.
 *
 * Ed25519 SPKI (RFC 8410) is exactly 44 bytes:
 *   30 2a 30 05 06 03 2b 65 70 03 21 00 <32-byte pubkey>
 *
 * The last 32 bytes of the SPKI are the raw public key bytes.
 */
export function extractEd25519PubkeyFromCert(der: Uint8Array): Uint8Array {
  // x509.X509Certificate requires ArrayBuffer (not Uint8Array<ArrayBufferLike>).
  const certBuf = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;
  const cert = new x509.X509Certificate(certBuf);
  const spki = new Uint8Array(cert.publicKey.rawData);
  if (spki.length !== 44) {
    throw new Error(`unexpected SPKI length ${spki.length}, expected 44 for Ed25519`);
  }
  // Verify OID 1.3.101.112 at bytes 4..8 = 06 03 2b 65 70
  if (
    spki[4] !== 0x06 ||
    spki[5] !== 0x03 ||
    spki[6] !== 0x2b ||
    spki[7] !== 0x65 ||
    spki[8] !== 0x70
  ) {
    throw new Error('SPKI algorithm OID is not Ed25519 (1.3.101.112)');
  }
  return spki.slice(12); // last 32 bytes = raw pubkey
}

// ---------------------------------------------------------------------------
// evaluatePinDecision (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Pure decision function for the TLS peer-cert check. Extracted so it can be
 * unit-tested without a live QUIC handshake.
 *
 * Returns `undefined` to accept the connection; returns a `CryptoError` to
 * reject. In `'observe'` mode a mismatch emits the `cert-pin-mismatch` event
 * for telemetry but still accepts, matching empirical mainnet behavior where
 * Frankendancer (and some Agave) validators present server certs whose SPKI
 * does not equal the gossip identity.
 */
export function evaluatePinDecision(args: {
  certs: Array<Uint8Array>;
  expectedPubkey: Uint8Array;
  identity: Address;
  pinMode: PinMode;
  emit: EventEmitter;
}): CryptoError | undefined {
  if (args.pinMode === 'off') return undefined;
  if (args.certs.length === 0 || args.certs[0] === undefined) {
    return CryptoError.BadCertificate;
  }
  let got: Uint8Array;
  try {
    got = extractEd25519PubkeyFromCert(args.certs[0]);
  } catch {
    return CryptoError.BadCertificate;
  }
  if (!uint8ArraysEqual(got, args.expectedPubkey)) {
    args.emit({
      type: 'cert-pin-mismatch',
      identity: args.identity,
      expected: hex(args.expectedPubkey),
      got: hex(got),
    });
    if (args.pinMode === 'strict') return CryptoError.BadCertificate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

