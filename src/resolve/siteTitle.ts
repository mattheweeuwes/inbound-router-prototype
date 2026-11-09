// Resolution step 4: read the homepage <title> / og:site_name of an unknown corporate domain.
// The domain comes from a stranger's email address, so it is checked before anything is fetched: a DNS name only, resolving only to public addresses,
// and the same checks on every redirect (https only, no IP literals, at most 3).
import dns from 'node:dns';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Ctx } from '../context';
import { cleanHostname } from '../normalize';

export interface SiteTitle { domain: string; title: string | null; siteName: string | null; error?: string; fetchedAt: string }

const UA = 'Mozilla/5.0 (compatible; inbound-router-prototype/0.1)';
const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export function extractTitles(html: string): { title: string | null; siteName: string | null } {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:site_name["']/i);
  return { title: t ? decodeEntities(t[1]) : null, siteName: og ? decodeEntities(og[1]) : null };
}

const cachePath = (ctx: Ctx) => join(ctx.cfg.cacheDir, 'site-title.json');
function readCache(ctx: Ctx): Record<string, SiteTitle> {
  try { return existsSync(cachePath(ctx)) ? JSON.parse(readFileSync(cachePath(ctx), 'utf8')) : {}; } catch { return {}; }
}

/** A found title is kept; a failed fetch is tried again after an hour. The cache holds at most this many domains, oldest dropped first. */
export const ERROR_TTL_MS = 3_600_000;
export const CACHE_MAX = 5000;
const MAX_REDIRECTS = 3;

export type Lookup = (host: string) => Promise<{ address: string }[]>;
const dnsLookup: Lookup = host => dns.promises.lookup(host, { all: true });

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}

// ---- which addresses a public website can have ----------------------------------------------------------------------------
/** Where a public web server is not: this network, private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges. */
function blockedV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved (255.255.255.255 too)
    || (a === 100 && b >= 64 && b <= 127) // CGNAT, 100.64.0.0/10
    || (a === 169 && b === 254) // link-local, which includes the cloud metadata address 169.254.169.254
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // private
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) // protocol assignments, test net 1, benchmarking
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113); // test nets 2 and 3
}

/** Eight 16-bit groups, or null. The caller has already checked that the text is an IPv6 address. */
function ipv6Groups(addr: string): number[] | null {
  let a = addr.split('%')[0].toLowerCase();
  if (a.includes('.')) { // a dotted IPv4 tail, as in ::ffff:127.0.0.1
    const cut = a.lastIndexOf(':');
    const q = a.slice(cut + 1).split('.').map(Number);
    if (q.length !== 4 || q.some(x => !(x >= 0 && x <= 255))) return null;
    a = `${a.slice(0, cut + 1)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const [head, tail, extra] = a.split('::');
  if (extra !== undefined) return null;
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const g = [...h, ...Array(fill).fill('0'), ...t].map(x => parseInt(x, 16));
  return g.length === 8 && g.every(x => x >= 0 && x <= 0xffff) ? g : null;
}

function blockedV6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zeros5 = g.slice(0, 5).every(x => x === 0);
  if (zeros5 && g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
  if (zeros5 && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]); // IPv4-mapped (::ffff:a.b.c.d) and the old IPv4-compatible form
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4(g[6], g[7]); // NAT64 carries an IPv4 address
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4 carries one too
  return (g[0] & 0xfe00) === 0xfc00 // unique local, fc00::/7
    || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 // link-local and the retired site-local
    || (g[0] & 0xff00) === 0xff00 // multicast
    || (g[0] === 0x2001 && g[1] === 0x0db8); // documentation
}

/** True for anything that is not an ordinary public address, and for text that is not an address at all. */
export function isBlockedAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) return blockedV4(addr.split('.').map(Number));
  if (kind === 6) { const g = ipv6Groups(addr); return !g || blockedV6(g); }
  return true;
}

/** Resolve the name now and refuse it if any answer is a non-public address. (A name that changes its answer between this check and the fetch is a known gap; see README.) */
async function assertPublicHost(host: string, lookup: Lookup) {
  const answers = await withTimeout(lookup(host), 3000, 'DNS lookup');
  if (!answers.length) throw new Error(`${host} does not resolve`);
  if (answers.some(a => isBlockedAddress(a.address))) throw new Error(`${host} resolves to a private or reserved address; not fetched`);
}

export async function fetchSiteTitle(ctx: Ctx, domain: string, lookup: Lookup = dnsLookup): Promise<SiteTitle> {
  const at = () => new Date(ctx.cfg.now()).toISOString();
  const host = cleanHostname(domain);
  if (!host) return { domain, title: null, siteName: null, error: 'not a valid DNS hostname; not fetched', fetchedAt: at() }; // never cached: it names nothing
  const cached = readCache(ctx)[host];
  if (cached && !(cached.error && ctx.cfg.now() - Date.parse(cached.fetchedAt) >= ERROR_TTL_MS)) return cached;
  let result: SiteTitle = { domain: host, title: null, siteName: null, fetchedAt: at() };
  try {
    let url = `https://${host}/`;
    let res: Response;
    for (let hop = 0; ; hop++) {
      await assertPublicHost(new URL(url).hostname, lookup);
      res = await ctx.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000), headers: { 'User-Agent': UA, Accept: 'text/html' } });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
      const next = new URL(location, url);
      if (next.protocol !== 'https:') throw new Error('redirect to a non-https address refused');
      if (!cleanHostname(next.hostname)) throw new Error('redirect to an IP address or a non-DNS host refused');
      url = next.toString();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // read at most 64KB
    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      const dec = new TextDecoder();
      let bytes = 0;
      while (bytes < 65536) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        html += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
    } else html = (await res.text()).slice(0, 65536);
    result = { ...result, ...extractTitles(html) };
  } catch (e) {
    result.error = (e as Error).message;
  }
  // failures are cached too, for an hour, so a replay never re-hits a dead site but a site that comes back is read again
  mkdirSync(ctx.cfg.cacheDir, { recursive: true });
  const fresh = readCache(ctx);
  fresh[host] = result;
  const keys = Object.keys(fresh);
  if (keys.length > CACHE_MAX) for (const k of keys.sort((a, b) => Date.parse(fresh[a].fetchedAt) - Date.parse(fresh[b].fetchedAt)).slice(0, keys.length - CACHE_MAX)) delete fresh[k];
  writeFileSync(cachePath(ctx), JSON.stringify(fresh, null, 1));
  return result;
}

/** "Chartis | Healthcare Consulting" -> ["Chartis | Healthcare Consulting", "Chartis", "Healthcare Consulting"] */
export function titleVariants(st: SiteTitle): string[] {
  const out: string[] = [];
  if (st.siteName) out.push(st.siteName);
  if (st.title) {
    out.push(st.title);
    for (const part of st.title.split(/\s[|\-–—:·]\s/)) if (part.trim().length > 2) out.push(part.trim());
  }
  return [...new Set(out)];
}
