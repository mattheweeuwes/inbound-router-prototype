// Which features a lead showed interest in, by rules, from the lead event alone: the door it came through (or the product an
// API key was made for), a gated guide, the pages an account visited, and words in its message. The cue table is
// FEATURE_CUES in src/usage/taxonomy.ts. Pure: an event in, tags out. A tag is a claim about interest and nothing more; no
// score, tier or route reads it (decision 30), and the model is never asked.
import type { LeadEvent } from '../schema';
import { ALL_FEATURE_KEYS, FEATURE_CUES, type DoorCue, type Feature } from '../usage/taxonomy';

/** How a lead showed interest, strongest first: the words it wrote, the door it chose, the page it visited, the guide it took. */
export const CUE_KINDS = ['message', 'door', 'path', 'guide'] as const;
export type CueKind = typeof CUE_KINDS[number];

export interface InterestTag { feature: Feature; cue: CueKind; evidence: string }

/** The slice of a lead event the cues read. */
export type CueSource = Pick<LeadEvent, 'source' | 'message' | 'context'>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliasCache = new Map<string, RegExp>();

/** Whole-word, any-case matcher for an alias; spaces in the alias match any run of whitespace. */
function aliasPattern(alias: string): RegExp {
  let re = aliasCache.get(alias);
  if (!re) {
    re = new RegExp(`\\b${alias.split(/\s+/).map(escapeRe).join('\\s+')}\\b`, 'i');
    aliasCache.set(alias, re);
  }
  return re;
}

/** The aliases found in the message, as the message wrote them. */
function messageEvidence(aliases: readonly string[], message: string | null): string | null {
  if (!message) return null;
  const found = aliases.flatMap(a => message.match(aliasPattern(a))?.[0] ?? []);
  return found.length ? [...new Set(found.map(w => w.toLowerCase()))].map(w => `"${w}"`).join(', ') : null;
}

const doorMatches = (cue: DoorCue, ev: CueSource): boolean =>
  cue.source === ev.source && (cue.product === undefined || String(ev.context.product ?? '').toLowerCase() === cue.product);

const doorWords = (cue: DoorCue) => (cue.product ? `${cue.source} door, product ${cue.product}` : `${cue.source} door`);

/** A visited path as the fragments are written: lowercase, no query or fragment, a trailing slash. */
export function normalizePath(path: string): string {
  const bare = path.toLowerCase().split(/[?#]/)[0];
  return bare.endsWith('/') ? bare : `${bare}/`;
}

/** The paths an account-level web visit hit, one per visit. Empty for any other door. */
const visitedPaths = (ev: CueSource): string[] =>
  Array.isArray(ev.context.visits)
    ? ev.context.visits.flatMap((v): string[] => (v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string' ? [(v as { path: string }).path] : []))
    : [];

function pathEvidence(fragments: readonly string[], paths: readonly string[]): string | null {
  const hits = paths.filter(p => fragments.some(f => normalizePath(p).includes(f)));
  if (!hits.length) return null;
  const distinct = [...new Set(hits)];
  return `${distinct.join(', ')}: ${hits.length} ${hits.length === 1 ? 'visit' : 'visits'}`;
}

/** The guide's form id and title as the door sent them. */
function guideEvidence(guides: readonly string[], ev: CueSource): string | null {
  const formId = typeof ev.context.formId === 'string' ? ev.context.formId : null;
  if (!formId || !guides.includes(formId)) return null;
  return typeof ev.context.guide === 'string' && ev.context.guide ? `guide "${ev.context.guide}"` : `guide ${formId}`;
}

/** Every feature the event shows interest in, each with how and the evidence. At most one tag per feature and cue, in a fixed order. */
export function interestTags(ev: CueSource): InterestTag[] {
  const paths = visitedPaths(ev);
  const tags: InterestTag[] = [];
  for (const feature of ALL_FEATURE_KEYS) {
    const cues = FEATURE_CUES[feature];
    const door = cues.doors.find(d => doorMatches(d, ev));
    const evidence: Record<CueKind, string | null> = {
      message: messageEvidence(cues.aliases, ev.message),
      door: door ? doorWords(door) : null,
      path: pathEvidence(cues.paths, paths),
      guide: guideEvidence(cues.guides, ev),
    };
    for (const cue of CUE_KINDS) if (evidence[cue]) tags.push({ feature, cue, evidence: evidence[cue] as string });
  }
  return tags;
}
