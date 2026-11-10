// Which account a usage event or a deal belongs to, through the account keys the router already uses (docs/DATA-CONTRACT.md,
// "Account keys"). PostHog's company group key is accepted in two forms: an account key itself (crm:..., ahrq:..., domain:...),
// or a domain. Either has to name an account the router knows: a CRM mirror entry, or an account a lead already created.
// Nothing here guesses: a group that matches neither stays unresolved, and the event is stored and counted that way.
import type { Ctx } from '../context';
import { matchMirror } from '../mirror';
import { domainChain } from '../resolve/domain';

const KEY_SHAPE = /^(ahrq|ccn|payer|npi|crm|domain|ein):\S+$/;

/** The mirror entry for a `crm:<id>` key. */
const mirrorEntry = (ctx: Ctx, key: string) => ctx.mirror.find(m => `crm:${m.id}` === key) ?? null;

function knownKey(ctx: Ctx, key: string): boolean {
  return mirrorEntry(ctx, key) !== null || ctx.store.accounts.exists(key);
}

/** A bare host: lowercased, a leading "www." dropped. Null when the text is not a plain DNS name. */
function hostOf(group: string): string | null {
  const h = group.toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null;
}

/** The account key for a company group key, or null when it names no account the router knows. */
export function accountForGroup(ctx: Ctx, group: string | null): string | null {
  if (!group) return null;
  if (KEY_SHAPE.test(group)) return knownKey(ctx, group) ? group : null;
  const host = hostOf(group);
  if (!host) return null;
  const mirror = matchMirror(ctx.mirror, host, null);
  if (mirror) return `crm:${mirror.id}`;
  for (const d of domainChain(host)) {
    const id = ctx.store.accounts.byDomain(d);
    if (id) return id;
  }
  return null;
}

export interface AccountInfo { key: string; name: string; segment: string | null; owner: string | null }

/** Name, segment and owner for an account key, from the CRM mirror or the router's own accounts. The key stands in for a name it cannot find. */
export function describeAccount(ctx: Ctx, key: string): AccountInfo {
  const m = mirrorEntry(ctx, key);
  if (m) return { key, name: m.name, segment: m.segment, owner: m.owner };
  const a = ctx.store.accounts.info(key);
  return { key, name: a?.name ?? key, segment: a?.segment ?? null, owner: a?.owner ?? null };
}
