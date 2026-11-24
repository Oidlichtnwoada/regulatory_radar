import { describe, expect, it } from 'vitest';
import { fetchPublic, isPublicAddress } from './public-fetch.js';

describe('fetch_url reaches public addresses only', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '147.67.0.1', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    'http://127.0.0.1:5432/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:3000/api/v1/radar',
    'file:///etc/passwd',
    'ftp://example.org/',
    'http://user:pw@example.org/',
  ])('refuses %s before connecting', async (url) => {
    await expect(fetchPublic(url, { timeoutMs: 2000, maxBytes: 1000 })).rejects.toThrow();
  });
});
