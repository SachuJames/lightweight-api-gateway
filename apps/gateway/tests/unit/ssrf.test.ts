import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUpstreamUrl, isPrivateIp } from '../../src/ssrf.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

const mockLookup = vi.mocked(lookup);

function addrs(...ips: string[]): LookupAddress[] {
  return ips.map((address, family) => ({ address, family }));
}

/** The mocked overload types a single address; the { all: true } call returns an array. */
function resolveTo(...ips: string[]) {
  mockLookup.mockResolvedValue(addrs(...ips) as unknown as LookupAddress);
}

describe('isPrivateIp', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['2001:db8::1', false],
    ['::ffff:127.0.0.1', true],
    ['::ffff:8.8.8.8', false],
  ])('classifies %s as %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe('assertPublicUpstreamUrl', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it('rejects hostnames resolving to loopback', async () => {
    resolveTo('127.0.0.1');
    await expect(assertPublicUpstreamUrl('http://localhost:3001', [])).rejects.toThrow(
      /private address/,
    );
    expect(mockLookup).toHaveBeenCalledWith('localhost', { all: true });
  });

  it('rejects literal private IPs', async () => {
    resolveTo('127.0.0.1');
    await expect(assertPublicUpstreamUrl('http://127.0.0.1:3001', [])).rejects.toThrow(
      /private address/,
    );
    resolveTo('10.0.0.5');
    await expect(assertPublicUpstreamUrl('http://10.0.0.5/', [])).rejects.toThrow(
      /private address/,
    );
  });

  it('rejects when any resolved address is private', async () => {
    resolveTo('93.184.216.34', '10.1.2.3');
    await expect(assertPublicUpstreamUrl('http://example.com/', [])).rejects.toThrow(
      /private address/,
    );
  });

  it('allows public addresses', async () => {
    resolveTo('93.184.216.34');
    await expect(assertPublicUpstreamUrl('http://example.com/', [])).resolves.toBeUndefined();
  });

  it('allows allowlisted hostnames to bypass the check', async () => {
    await expect(
      assertPublicUpstreamUrl('http://localhost:3001', ['localhost']),
    ).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicUpstreamUrl('ftp://example.com/', [])).rejects.toThrow(
      /Invalid upstream URL/,
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects hostnames that do not resolve', async () => {
    const err = new Error('getaddrinfo ENOTFOUND') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    mockLookup.mockRejectedValue(err);
    await expect(assertPublicUpstreamUrl('http://does-not-exist.example/', [])).rejects.toThrow(
      /does not resolve/,
    );
  });
});
