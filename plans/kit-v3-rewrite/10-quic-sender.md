# 10 — quic-sender.ts

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 02, 03, 04, 06, 09 (VERIFY: `test -f src/errors.ts -a -f src/addr.ts -a -f plans/kit-v3-rewrite/NOTES-04.md -a -f src/identity.ts -a -f src/quic-pool.ts`)
TOUCHES: src/quic-sender.ts

## Goal
Transport adapter over `@matrixai/quic`. Opens a QUIC connection with:
- Client cert = user identity (from `identity.ts`)
- ALPN = `'solana-tpu'` (mandatory — Firedancer rejects otherwise)
- Server cert pinning via `verifyCallback` matching SPKI Ed25519 pubkey against expected leader identity

Exposes a `sendOnce(entry, txBytes, signal)` that opens a unidirectional stream, writes the tx, waits for ack, cleans up on abort.

## Approach

**IMPORTANT**: Before writing, read `plans/kit-v3-rewrite/NOTES-04.md` for the verified `verifyCallback` signature from concern 04. The pseudocode below assumes the likely shape — ADJUST to match NOTES-04.

```ts
import { QUICClient } from '@matrixai/quic';
import * as x509 from '@peculiar/x509';
import { parseHostPort } from './addr.js';
import type { TpuIdentity } from './identity.js';
import type { QuicConnection, PoolEntry } from './quic-pool.js';
import type { EventEmitter } from './events.js';
import type { TpuError } from './errors.js';
import type { Address } from '@solana/kit';

const CONNECT_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 2_000;

export interface OpenArgs {
  identity: Address;
  addr: string;
  maxStreams: number;
  tpuIdentity: TpuIdentity;
  emit: EventEmitter;
}

export async function openTpuQuicConn(args: OpenArgs): Promise<QuicConnection> {
  const { host, port } = parseHostPort(args.addr);
  const expectedPubkey = decodeBase58(args.identity); // 32-byte Ed25519 raw

  const client = await withTimeout(CONNECT_TIMEOUT_MS, QUICClient.createQUICClient({
    host,
    port,
    crypto: /* per NOTES-04, expected shape */ undefined as any,
    config: {
      applicationProtos: ['solana-tpu'],
      verifyPeer: true, // ensure verifyCallback is invoked
      verifyCallback: async (certDerChain: Uint8Array[]) => {
        if (!certDerChain[0]) throw pinError(args.identity, expectedPubkey, new Uint8Array());
        const got = extractEd25519PubkeyFromCert(certDerChain[0]);
        if (!uint8ArraysEqual(got, expectedPubkey)) {
          args.emit({
            type: 'cert-pin-mismatch',
            identity: args.identity,
            expected: hex(expectedPubkey),
            got: hex(got),
          });
          throw pinError(args.identity, expectedPubkey, got);
        }
      },
      // Client cert for QoS identity:
      cert: args.tpuIdentity.certDer,
      key: args.tpuIdentity.keyPair.privateKey,
      // Per-conn stream limits (mirrors Agave defaults):
      initialMaxStreamsUni: args.maxStreams,
      maxIdleTimeout: 30_000,
    },
  }));

  return {
    isOpen: () => !(client as any).destroyed,
    destroy: async (_reason?: string) => {
      try { await client.destroy({ force: true }); } catch {}
    },
    // Internal handle for sendOnce. Keep it on a symbol to avoid leaking.
    [INNER]: client,
  } as QuicConnection & { [INNER]: QUICClient };
}

const INNER = Symbol('quic-client');

export async function sendOnce(
  entry: PoolEntry,
  txBytes: Uint8Array,
  signal: AbortSignal,
): Promise<{ rttMs: number } | TpuError> {
  if (!entry.streamSlots.tryAcquire()) return { kind: 'backpressure', identity: entry.identity };
  const started = Date.now();
  let stream: any;
  try {
    const client = (entry.conn as any)[INNER] as QUICClient;
    stream = await client.connection.newStream('uni');
    const writer = stream.writable.getWriter();
    const abortHandler = () => { writer.abort('aborted').catch(() => {}); stream.cancel('aborted').catch(() => {}); };
    signal.addEventListener('abort', abortHandler, { once: true });
    try {
      await withTimeout(WRITE_TIMEOUT_MS, (async () => {
        await writer.write(txBytes);
        await writer.close();
      })());
    } finally {
      signal.removeEventListener('abort', abortHandler);
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

export function extractEd25519PubkeyFromCert(der: Uint8Array): Uint8Array {
  const cert = new x509.X509Certificate(der);
  const spki = new Uint8Array(cert.publicKey.rawData);
  if (spki.length !== 44) throw new Error(`unexpected SPKI length ${spki.length}`);
  return spki.slice(12);
}

function pinError(identity: Address, expected: Uint8Array, got: Uint8Array): Error {
  const err = new Error(`cert pubkey mismatch for ${identity}`);
  (err as any).details = { kind: 'cert-pin-mismatch', identity, expected: hex(expected), got: hex(got) };
  return err;
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function decodeBase58(/* s: Address */): Uint8Array {
  // TODO: use kit's getAddressCodec().decode(s)
  throw new Error('implement via kit getAddressCodec');
}
```

## Decisions

- **No retry inside `sendOnce`**: the fan-out happens at the `tpu-client` orchestration layer. A single send attempt to a single leader is the unit. The orchestrator decides whether to retry.
- **Abort wiring**: explicit `writer.abort()` + `stream.cancel()` to prevent leaked streams (RT-A#7).
- **`cert-pin-mismatch`**: event emitted from `verifyCallback` AND returned as an attempt error. Pool-level quarantine (mark leader as bad for the epoch) is the `tpu-client` orchestration's responsibility.
- **decodeBase58**: use kit's `getAddressCodec()` to get raw 32 bytes from an `Address` string. Implementer to wire.
- **Crypto wiring**: `@matrixai/quic` needs a crypto provider. NOTES-04 clarifies what to pass (Node's `webcrypto` may need wrapping).

## Open issues (from NOTES-04)

The pseudocode is provisional. Adapt based on NOTES-04:
- `verifyCallback` may receive parsed `X509Certificate[]` not `Uint8Array[]`.
- `cert`/`key` option names may differ (`certChainPem`, `privateKeyPem` are common alternatives).
- `QUICClient.createQUICClient` signature may require different nesting.

## Verify

```bash
npx tsc --noEmit
grep -q "solana-tpu" src/quic-sender.ts
grep -q "verifyCallback" src/quic-sender.ts
grep -q "writer.abort\|stream.cancel" src/quic-sender.ts
```

Integration test (concern 15): send a real tx to `solana-test-validator`, confirm via `signatureNotifications`. ALPN rejection smoke test: connect without ALPN, expect rejection.
