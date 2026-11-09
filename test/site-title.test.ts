// The homepage-title lookup fetches a domain taken from a stranger's email address, so it must never reach an internal address.
// Every test here uses an injected DNS lookup and a recording fetch: nothing touches the network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_MAX, ERROR_TTL_MS, fetchSiteTitle, isBlockedAddress, type Lookup } from '../src/resolve/siteTitle';
import { submit, testCtx } from './helpers';

const page = (title: string) => new Response(`<html><head><title>${title}</title></head><body>hi</body></html>`, { status: 200 });
const redirect = (to: string, status = 301) => new Response(null, { status, headers: { location: to } });
const PUBLIC = '93.184.216.34';

/** A DNS lookup that answers from a table (anything not listed is a public address) and records what it was asked. */
function dnsTable(table: Record<string, string[]> = {}) {
  const asked: string[] = [];
  const lookup: Lookup = async host => { asked.push(host); return (table[host] ?? [PUBLIC]).map(address => ({ address })); };
  return { asked, lookup };
}

/** A fetch that records every URL and answers from `handler`. */
function recorder(handler: (url: string, n: number) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetch = (async (u: unknown) => { urls.push(String(u)); return handler(String(u), urls.length); }) as typeof globalThis.fetch;
  return { urls, fetch };
}

const cacheFile = (ctx: ReturnType<typeof testCtx>) => join(ctx.cfg.cacheDir, 'site-title.json');

describe('which addresses count as internal', () => {
  it('blocks private, loopback, link-local, CGNAT, unique-local, multicast and reserved ranges, IPv4 and IPv6', () => {
    const blocked = ['0.0.0.0', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.1', '100.127.255.255',
      '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
      '::', '::1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '2001:db8::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::', 'not an address', ''];
    for (const a of blocked) assert.equal(isBlockedAddress(a), true, a);
  });
  it('allows ordinary public addresses, including the neighbours of the blocked ranges', () => {
    const open = ['8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '169.253.1.1', '192.167.1.1', '198.17.0.1', '223.255.255.255',
      '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'];
    for (const a of open) assert.equal(isBlockedAddress(a), false, a);
  });
});

describe('fetchSiteTitle', () => {
  it('fetches a public name over https and reads the title', async () => {
    const ctx = testCtx();
    const dns = dnsTable();
    const f = recorder(() => page('Acme Health | Contracting'));
    ctx.fetch = f.fetch;
    const out = await fetchSiteTitle(ctx, 'acme-health.com', dns.lookup);
    assert.equal(out.error, undefined);
    assert.equal(out.title, 'Acme Health | Contracting');
    assert.deepEqual(f.urls, ['https://acme-health.com/']);
    assert.deepEqual(dns.asked, ['acme-health.com']);
  });

  it('never fetches a name that resolves to an internal address, even when only one answer is internal', async () => {
    for (const answers of [['10.0.0.5'], ['127.0.0.1'], ['169.254.169.254'], ['::1'], ['fd00::1'], [PUBLIC, '192.168.1.10'], ['::ffff:10.0.0.1']]) {
      const ctx = testCtx();
      const f = recorder(() => page('x'));
      ctx.fetch = f.fetch;
      const out = await fetchSiteTitle(ctx, 'internal.example.org', dnsTable({ 'internal.example.org': answers }).lookup);
      assert.match(out.error ?? '', /private or reserved/, answers.join(','));
      assert.equal(f.urls.length, 0, answers.join(','));
      assert.equal(out.title, null);
    }
  });

  it('a name that does not resolve is an error, not a fetch', async () => {
    const ctx = testCtx();
    const f = recorder(() => page('x'));
    ctx.fetch = f.fetch;
    const out = await fetchSiteTitle(ctx, 'nowhere.example.org', async () => { throw new Error('ENOTFOUND'); });
    assert.match(out.error ?? '', /ENOTFOUND/);
    assert.equal(f.urls.length, 0);
  });

  it('refuses anything that is not a plain DNS hostname, before any lookup or fetch, and caches nothing', async () => {
    const ctx = testCtx();
    const dns = dnsTable();
    const f = recorder(() => page('x'));
    ctx.fetch = f.fetch;
    for (const d of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1:8080/y.co', 'evil.com:8080', 'a.co/path', 'a.co?x=1', '127.0.0.0x1', 'user@a.co', '']) {
      const out = await fetchSiteTitle(ctx, d, dns.lookup);
      assert.match(out.error ?? '', /not a valid DNS hostname/, d);
    }
    assert.equal(f.urls.length, 0);
    assert.equal(dns.asked.length, 0);
    assert.equal(existsSync(cacheFile(ctx)), false);
  });

  it('refuses a redirect to http', async () => {
    const ctx = testCtx();
    const f = recorder(() => redirect('http://other.example.org/'));
    ctx.fetch = f.fetch;
    const out = await fetchSiteTitle(ctx, 'acme-health.com', dnsTable().lookup);
    assert.match(out.error ?? '', /non-https/);
    assert.deepEqual(f.urls, ['https://acme-health.com/'], 'the http address is never fetched');
  });

  it('refuses a redirect to an IP literal, and a redirect to a name that resolves internally', async () => {
    for (const to of ['https://127.0.0.1/', 'https://[::1]:8443/', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/', 'https://127.0.0.0x1/', '//169.254.169.254/']) {
      const ctx = testCtx();
      const f = recorder(() => redirect(to));
      ctx.fetch = f.fetch;
      const out = await fetchSiteTitle(ctx, 'acme-health.com', dnsTable().lookup);
      assert.match(out.error ?? '', /refused/, to);
      assert.equal(f.urls.length, 1, `${to} is never fetched`);
    }
    const ctx = testCtx();
    const f = recorder(() => redirect('https://intranet.example.org/'));
    ctx.fetch = f.fetch;
    const out = await fetchSiteTitle(ctx, 'acme-health.com', dnsTable({ 'intranet.example.org': ['10.1.1.1'] }).lookup);
    assert.match(out.error ?? '', /private or reserved/);
    assert.equal(f.urls.length, 1);
  });

  it('follows at most 3 redirects', async () => {
    const chain = (hops: number) => recorder((_u, n) => (n <= hops ? redirect(`https://hop${n}.example.org/`) : page('Landed')));
    const ok = testCtx();
    const three = chain(3);
    ok.fetch = three.fetch;
    assert.equal((await fetchSiteTitle(ok, 'acme-health.com', dnsTable().lookup)).title, 'Landed');
    assert.equal(three.urls.length, 4);
    const tooMany = testCtx();
    const four = chain(4);
    tooMany.fetch = four.fetch;
    const out = await fetchSiteTitle(tooMany, 'acme-health.com', dnsTable().lookup);
    assert.match(out.error ?? '', /too many redirects/);
    assert.equal(four.urls.length, 4, 'the fourth redirect is not followed');
  });

  it('caches a failure for one hour, then tries again; a found title stays cached', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const ctx = testCtx({ now: () => t });
    let up = false;
    const f = recorder(() => { if (!up) throw new TypeError('fetch failed'); return page('Back Online'); });
    ctx.fetch = f.fetch;
    const dns = dnsTable();
    assert.match((await fetchSiteTitle(ctx, 'flaky.example.org', dns.lookup)).error ?? '', /fetch failed/);
    assert.equal(f.urls.length, 1);
    t += ERROR_TTL_MS - 60_000;
    up = true;
    assert.match((await fetchSiteTitle(ctx, 'flaky.example.org', dns.lookup)).error ?? '', /fetch failed/, 'still the cached failure at 59 minutes');
    assert.equal(f.urls.length, 1, 'no new fetch inside the hour');
    t += 60_000;
    const again = await fetchSiteTitle(ctx, 'flaky.example.org', dns.lookup);
    assert.equal(f.urls.length, 2, 'fetched again at one hour');
    assert.equal(again.title, 'Back Online');
    t += 100 * ERROR_TTL_MS;
    assert.equal((await fetchSiteTitle(ctx, 'flaky.example.org', dns.lookup)).title, 'Back Online');
    assert.equal(f.urls.length, 2, 'a found title is not fetched again');
  });

  it('keeps the cache to about 5,000 domains, dropping the oldest', async () => {
    const ctx = testCtx();
    mkdirSync(ctx.cfg.cacheDir, { recursive: true });
    const seed: Record<string, unknown> = {};
    for (let i = 0; i < CACHE_MAX; i++) seed[`d${i}.example.org`] = { domain: `d${i}.example.org`, title: `T${i}`, siteName: null, fetchedAt: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString() };
    writeFileSync(cacheFile(ctx), JSON.stringify(seed));
    const f = recorder(() => page('Newcomer'));
    ctx.fetch = f.fetch;
    await fetchSiteTitle(ctx, 'newcomer.example.org', dnsTable().lookup);
    const after = JSON.parse(readFileSync(cacheFile(ctx), 'utf8')) as Record<string, unknown>;
    assert.equal(Object.keys(after).length, CACHE_MAX);
    assert.ok(after['newcomer.example.org']);
    assert.equal('d0.example.org' in after, false, 'the oldest entry went');
    assert.ok(after['d1.example.org'] && after[`d${CACHE_MAX - 1}.example.org`]);
  });
});

describe('SSRF-shaped emails through the pipeline', () => {
  it('never reach a site-title fetch, with the network on', async () => {
    for (const email of ['x@127.0.0.1:8080/y.co', 'x@localhost', 'x@[::1]', 'x@169.254.169.254', 'x@evil.com:8080']) {
      const urls: string[] = [];
      const ctx = testCtx({ network: true }, (async (u: unknown) => { urls.push(String(u)); throw new TypeError('fetch failed'); }) as typeof globalThis.fetch);
      const { status, lead } = await submit(ctx, 'guide_download', { email, company: 'Zzyzx Unknown Co', title: 'Practice Manager', message: undefined });
      assert.equal(status, 202, email);
      assert.equal(lead.status, 'done', email);
      assert.equal(lead.normalized.email, null, email);
      assert.equal(lead.normalized.companyDomain, null, email);
      // the only outbound call a lead with this company name may make is the NPPES lookup by name, never a fetch of the domain
      assert.deepEqual(urls.filter(u => !u.startsWith('https://npiregistry.cms.hhs.gov/')), [], email);
    }
  });
});
