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
  // Strip IPv6 brackets from hostname (e.g. "[::1]" → "::1")
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return { host, port };
}

/** F2: Non-throwing variant — returns null on invalid input. */
export function tryParseHostPort(input: string): HostPort | null {
  try {
    return parseHostPort(input);
  } catch {
    return null;
  }
}

export function formatHostPort(hp: HostPort): string {
  return hp.host.includes(':') ? `[${hp.host}]:${hp.port}` : `${hp.host}:${hp.port}`;
}

/** Derive tpu_quic endpoint from a plain tpu endpoint per Solana convention. */
export function tpuQuicFromTpu(tpu: string): string {
  const { host, port } = parseHostPort(tpu);
  return formatHostPort({ host, port: port + 6 });
}

/** Resolve best TPU-QUIC address from a gossip ContactInfo shape.
 *  Returns null if neither field is present OR if the resolved addr is unparseable. */
export function resolveTpuQuicAddr(contact: {
  tpuQuic?: string | null;
  tpu?: string | null;
}): string | null {
  if (contact.tpuQuic) {
    // F2: validate that the tpuQuic addr is parseable before returning it.
    if (tryParseHostPort(contact.tpuQuic) === null) return null;
    return contact.tpuQuic;
  }
  if (contact.tpu) {
    // tpuQuicFromTpu uses parseHostPort internally; catch via tryParseHostPort first.
    if (tryParseHostPort(contact.tpu) === null) return null;
    return tpuQuicFromTpu(contact.tpu);
  }
  return null;
}
