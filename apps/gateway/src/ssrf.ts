import * as dns from 'node:dns/promises';
import { ErrorCodes, GatewayError } from './errors.js';

/**
 * True when the IP literal is private, loopback, link-local, or otherwise
 * not publicly routable. Used to block server-side request forgery through
 * route upstream URLs.
 */
export function isPrivateIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 addresses (::ffff:1.2.3.4).
  const normalized = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;

  if (normalized.includes(':')) {
    const lower = normalized.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fe80:')) return true; // link-local
    // Unique local addresses, fc00::/7 (first byte 0xFC or 0xFD).
    if (lower[0] === 'f' && (lower[1] === 'c' || lower[1] === 'd')) return true;
    return false;
  }

  const parts = normalized.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    return false;
  }
  const [a, b] = parts.map(Number) as [number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  return false;
}

/**
 * Reject upstream URLs that resolve to non-public IP addresses, so a route
 * cannot turn the gateway into a probe for internal infrastructure.
 *
 * Hostnames listed in `allowlist` bypass the check; that list exists for
 * local development only (e.g. compose service names) and must stay empty
 * in production. Throws a GatewayError (400) when the URL is unsafe.
 */
export async function assertPublicUpstreamUrl(
  upstreamUrl: string,
  allowlist: string[],
): Promise<void> {
  let hostname: string;
  try {
    const parsed = new URL(upstreamUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('not http(s)');
    }
    hostname = parsed.hostname;
  } catch {
    throw new GatewayError(ErrorCodes.BAD_REQUEST, 400, `Invalid upstream URL: ${upstreamUrl}`);
  }

  if (allowlist.includes(hostname)) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new GatewayError(
      ErrorCodes.BAD_REQUEST,
      400,
      `Upstream hostname does not resolve: ${hostname}`,
    );
  }

  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new GatewayError(
      ErrorCodes.BAD_REQUEST,
      400,
      `Upstream URL resolves to a private address and is not allowed: ${hostname}`,
    );
  }
}
