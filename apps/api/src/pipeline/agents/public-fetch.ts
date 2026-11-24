import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { USER_AGENT } from '../../sources/http.js';

/** Address ranges an agent may never reach (loopback, private, link-local, CGNAT, documentation, multicast, ...). */
const BLOCKED: readonly (readonly [string, number, 'ipv4' | 'ipv6'])[] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 96, 'ipv6'], // unspecified, loopback and IPv4-compatible
  ['64:ff9b::', 96, 'ipv6'], // NAT64 (embeds an IPv4 address)
  ['100::', 64, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['fec0::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

/** The blocked ranges; IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are checked against the IPv4 ranges. */
const blockList = BLOCKED.reduce((list, [net, prefix, type]) => {
  list.addSubnet(net, prefix, type);
  return list;
}, new BlockList());

/** True for a public unicast IP address (IPv4 or IPv6, including IPv4-mapped forms). */
export const isPublicAddress = (ip: string): boolean => {
  const version = isIP(ip);
  if (version === 0) return false;
  if (version === 6 && /^::ffff:/i.test(ip)) {
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
    if (v4) return isPublicAddress(v4);
  }
  return !blockList.check(ip, version === 4 ? 'ipv4' : 'ipv6');
};

/** DNS lookup that fails when any resolved address is not public (checked at connect time: no DNS rebinding). */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    const blocked = addresses.find((a) => !isPublicAddress(a.address));
    if (blocked || addresses.length === 0)
      return callback(new Error(`${hostname} resolves to a non-public address`), '', 0);
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    const [first] = addresses;
    return callback(null, first?.address ?? '', first?.family ?? 4);
  });
};

/** Result of a public fetch. */
export interface PublicResponse {
  /** HTTP status of the final response. */
  readonly status: number;
  /** Final URL after redirects. */
  readonly url: string;
  /** Content type of the final response. */
  readonly contentType: string;
  /** Body as UTF-8 text, at most `maxBytes`. */
  readonly text: string;
  /** True when the body was cut at `maxBytes`. */
  readonly truncated: boolean;
}

/** Options of a public fetch. */
export interface PublicFetchOptions {
  /** Overall timeout including redirects. */
  readonly timeoutMs: number;
  /** Largest body read (bytes). */
  readonly maxBytes: number;
  /** Redirects followed at most (each target is checked again). */
  readonly maxRedirects?: number;
}

/** Checks a URL's scheme and literal host before connecting; the DNS answer is checked by publicLookup. */
const checkedUrl = (raw: string): URL => {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https URLs');
  if (url.username || url.password) throw new Error('URLs with credentials are not fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new Error(`${host} is not a public address`);
  if (/^localhost\.?$/i.test(host) || host.endsWith('.localhost')) throw new Error('localhost is not public');
  return url;
};

/** One GET without following redirects; reads at most maxBytes of the body. */
const getOnce = (url: URL, maxBytes: number, signal: AbortSignal) =>
  new Promise<PublicResponse & { readonly location: string | null }>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(
      url,
      {
        lookup: publicLookup,
        signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        const state = { bytes: 0, truncated: false };
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            url: url.toString(),
            contentType: String(res.headers['content-type'] ?? ''),
            text: Buffer.concat(chunks).toString('utf8'),
            truncated: state.truncated,
            location: res.headers.location ?? null,
          });
        res.on('data', (chunk: Buffer) => {
          const room = maxBytes - state.bytes;
          chunks.push(chunk.subarray(0, Math.max(0, room)));
          state.bytes += chunk.length;
          if (state.bytes >= maxBytes) {
            state.truncated = state.bytes > maxBytes;
            res.destroy();
            done();
          }
        });
        res.on('end', done);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });

/**
 * GET of a public web page for the agents: http(s) only, every hop's address must be public (checked when
 * connecting, so DNS rebinding cannot reach internal hosts such as the database or cloud metadata), redirects are
 * followed manually and re-checked, and the body is capped.
 */
export const fetchPublic = async (raw: string, opts: PublicFetchOptions): Promise<PublicResponse> => {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const hop = async (url: URL, left: number): Promise<PublicResponse> => {
    const { location, ...res } = await getOnce(url, opts.maxBytes, signal);
    if (res.status < 300 || res.status >= 400 || !location) return res;
    if (left <= 0) throw new Error('too many redirects');
    return hop(checkedUrl(new URL(location, url).toString()), left - 1);
  };
  return hop(checkedUrl(raw), opts.maxRedirects ?? 5);
};
