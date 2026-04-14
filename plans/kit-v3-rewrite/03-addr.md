# 03 — addr.ts

STATUS: open
PRIORITY: p1
COMPLEXITY: mechanical
BLOCKED_BY: 01 (VERIFY: `test -f tsconfig.json`)
TOUCHES: src/addr.ts

## Goal
Parse `host:port` strings from gossip's `tpu_quic` / `tpu` fields into `{host, port}`, correctly handling IPv6 bracketed form and hostnames. Provide a `tpu+6` fallback helper for validators that don't advertise `tpu_quic`.

## Approach

```ts
export interface HostPort { host: string; port: number; }

export function parseHostPort(input: string): HostPort {
  // Support "1.2.3.4:8009", "[::1]:8009", "host.example:8009"
  // Use URL to leverage built-in v6 bracket handling.
  const url = new URL(`quic://${input}`);
  if (!url.hostname || !url.port) throw new Error(`invalid host:port ${input}`);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${url.port}`);
  }
  // URL hostname strips v6 brackets — restore caller-safe host (unbracketed works for QUIC lib).
  return { host: url.hostname, port };
}

export function formatHostPort(hp: HostPort): string {
  return hp.host.includes(':') ? `[${hp.host}]:${hp.port}` : `${hp.host}:${hp.port}`;
}

/** Derive tpu_quic endpoint from a plain tpu endpoint per Solana convention. */
export function tpuQuicFromTpu(tpu: string): string {
  const { host, port } = parseHostPort(tpu);
  return formatHostPort({ host, port: port + 6 });
}

/** Resolve best TPU-QUIC address from a gossip ContactInfo shape. */
export function resolveTpuQuicAddr(contact: {
  tpuQuic?: string | null;
  tpu?: string | null;
}): string | null {
  if (contact.tpuQuic) return contact.tpuQuic;
  if (contact.tpu) return tpuQuicFromTpu(contact.tpu);
  return null;
}
```

## Rules

- No deps beyond `URL` (native).
- Pure functions, no state.
- Explicit errors on malformed input — the refresh loop catches and skips.

## Verify

Unit tests in concern 14 will cover:
- IPv4 happy path
- IPv6 `[::1]:8009`
- Hostname `validator.example:8009`
- Invalid port (0, 65536, non-numeric) → throws
- Missing port → throws
- `tpuQuicFromTpu` adds 6 to port
- `resolveTpuQuicAddr` prefers `tpuQuic`, falls back to `tpu+6`, returns null if both absent

For this concern just run:
```bash
npx tsc --noEmit
```
