// The one gate in front of a copy that is reachable from outside this machine: HTTP Basic with a shared password
// (ACCESS_PASSWORD). It is off unless the password is set, so the local server behaves as before. There is still no sign-in:
// the gate says who may open the copy, not who decided what.
import { createHash, timingSafeEqual } from 'node:crypto';

export const ACCESS_REALM = 'Inbound Router';

/** What the server answers when a request may not pass. */
export interface AccessRefusal { status: 401; headers: Record<string, string>; body: string }

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Where to send a request that reached a password-protected copy over plain http, or null. Behind a tunnel or a proxy the first hop
 * says how the visitor connected (X-Forwarded-Proto); such a request is sent to https before the password is asked for, so the
 * password never travels in the clear. A direct local request carries no such header and is left alone.
 */
export function httpsRedirect(forwardedProto: string | undefined, host: string | undefined, url: string | undefined, password: string | null): string | null {
  if (!password || !host) return null;
  return (forwardedProto ?? '').split(',')[0].trim().toLowerCase() === 'http' ? `https://${host}${url ?? '/'}` : null;
}

/** The password in an Authorization header, or null when the header is not a readable Basic credential. Any user name is accepted. */
export function passwordFrom(authorization: string | undefined): string | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization ?? '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/**
 * Null when the request may pass: the gate is off, or the header carries the password. Otherwise the 401 to send, which asks the
 * browser for the password and tells crawlers to keep nothing. The comparison is on digests in constant time, so neither the
 * length of the password nor how much of a guess was right shows in the timing.
 */
export function refuseAccess(authorization: string | undefined, password: string | null): AccessRefusal | null {
  if (!password) return null;
  const given = passwordFrom(authorization);
  if (given !== null && timingSafeEqual(digest(given), digest(password))) return null;
  return {
    status: 401,
    headers: {
      'www-authenticate': `Basic realm="${ACCESS_REALM}", charset="UTF-8"`, 'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow',
    },
    body: 'This copy is password protected.',
  };
}
