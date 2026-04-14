import { describe, it, expect } from 'vitest';
import {
  parseHostPort,
  tpuQuicFromTpu,
  resolveTpuQuicAddr,
} from '../../src/addr.js';

describe('parseHostPort', () => {
  it('IPv4 happy path', () => {
    expect(parseHostPort('1.2.3.4:8009')).toEqual({ host: '1.2.3.4', port: 8009 });
  });

  it('IPv6 bracketed', () => {
    expect(parseHostPort('[::1]:8009')).toEqual({ host: '::1', port: 8009 });
  });

  it('hostname', () => {
    const result = parseHostPort('validator.example:8009');
    expect(result.host).toBe('validator.example');
    expect(result.port).toBe(8009);
  });

  it('throws on port 0', () => {
    expect(() => parseHostPort('1.2.3.4:0')).toThrow();
  });

  it('throws on port 65536', () => {
    expect(() => parseHostPort('1.2.3.4:65536')).toThrow();
  });

  it('throws on non-numeric port', () => {
    // URL will fail to parse 'abc' as port
    expect(() => parseHostPort('1.2.3.4:abc')).toThrow();
  });

  it('throws on missing port', () => {
    expect(() => parseHostPort('1.2.3.4')).toThrow();
  });
});

describe('tpuQuicFromTpu', () => {
  it('adds 6 to the port', () => {
    expect(tpuQuicFromTpu('1.2.3.4:8003')).toBe('1.2.3.4:8009');
  });
});

describe('resolveTpuQuicAddr', () => {
  it('returns tpuQuic if present', () => {
    expect(resolveTpuQuicAddr({ tpuQuic: 'x', tpu: 'y' })).toBe('x');
  });

  it('derives from tpu if no tpuQuic', () => {
    expect(resolveTpuQuicAddr({ tpu: '1.2.3.4:8003' })).toBe('1.2.3.4:8009');
  });

  it('returns null if neither present', () => {
    expect(resolveTpuQuicAddr({})).toBeNull();
  });
});
