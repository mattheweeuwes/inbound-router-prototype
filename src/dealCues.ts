// Deal-size cues in the prospect's own message (decision 25): phrases that say the deal is large whoever the account is.
// Rules only, on purpose. These are not classifier labels: they never go to the model, they are not in the hashed classifier
// files, and they add no points. They feed one routing rule (R10 in src/route.ts) and the rep's brief, with the phrase quoted.

export type DealCueKind = 'enterprise_license' | 'full_dataset' | 'broad_coverage' | 'multi_year' | 'multi_entity' | 'approved_budget';

export interface DealCue {
  kind: DealCueKind;
  /** the words as the prospect wrote them */
  phrase: string;
  /** where the phrase starts in the message, so cues read in the prospect's order */
  index: number;
}

const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
/** "five or more states" is a cue; two or three states is a regional deal. */
export const MIN_STATES_CUE = 5;

const WORD = `[\\w'-]+\\s+`;
const PATTERNS: { kind: DealCueKind; re: RegExp; keep?: (m: RegExpExecArray) => boolean }[] = [
  { kind: 'enterprise_license', re: new RegExp(`\\b(?:bulk|enterprise(?:-wide)?|organi[sz]ation-wide|company-wide|system-wide)\\s+(?:data\\s+)?licen[cs](?:e|es|ing)\\b`, 'gi') },
  { kind: 'enterprise_license', re: new RegExp(`\\bbulk\\s+(?:${WORD}){0,2}?(?:data\\s?sets?|data|downloads?|exports?|extracts?|feeds?|files?)\\b`, 'gi') },
  { kind: 'full_dataset', re: new RegExp(`\\b(?:full|entire|whole|complete)\\s+(?:${WORD}){0,2}?(?:data\\s?sets?|data lake|database)\\b`, 'gi') },
  { kind: 'full_dataset', re: /\bdata lake\b/gi },
  { kind: 'broad_coverage', re: /\ball\s+(?:the\s+)?(?:payers|plans|states|markets|50 states|fifty states)\b/gi },
  { kind: 'broad_coverage', re: /\bnation(?:wide|al coverage)\b/gi },
  {
    kind: 'broad_coverage', re: /\b(\d{1,2}|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)\s+(?:different\s+)?states\b/gi,
    keep: m => (Number(m[1]) || NUMBER_WORDS[m[1].toLowerCase()] || 0) >= MIN_STATES_CUE,
  },
  { kind: 'multi_year', re: /\bmulti-?\s?year\b/gi },
  { kind: 'multi_year', re: /\b(?:two|three|four|five|2|3|4|5)[- ]year\s+(?:term|contract|agreement|deal|licen[cs]e|commitment|subscription)\b/gi },
  { kind: 'multi_entity', re: new RegExp(`\\bportfolio\\s+(?:${WORD})?(?:companies|cos|msos?|practices|groups|hospitals|platforms|entities)\\b`, 'gi') },
  { kind: 'multi_entity', re: /\b(?:several|multiple|each of our|all (?:of )?our)\s+(?:[\w'-]+\s+)?(?:entities|subsidiaries|affiliates|health plans|business units|portfolio companies)\b/gi },
  { kind: 'approved_budget', re: /\bbudget\s+(?:is|has been|was|'s)\s+(?:already\s+)?(?:approved|allocated|secured|signed off|in place)\b/gi },
  { kind: 'approved_budget', re: /\b(?:approved|allocated|secured)\s+budget\b/gi },
];

/** A phrase preceded by a negation in the same clause ("not looking for a bulk license", "no approved budget yet") is not a cue. */
const NEGATED = /\b(?:no|not|without|never|don't|do not|isn't|aren't)\b[^.;,!?]{0,25}$/i;

/** Every deal-size cue in a message, in the order the prospect wrote them. Overlapping matches keep the earlier, longer one. */
export function findDealCues(message: string | null): DealCue[] {
  if (!message) return [];
  const found: DealCue[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(message); m; m = p.re.exec(message)) {
      if (p.keep && !p.keep(m)) continue;
      if (NEGATED.test(message.slice(0, m.index))) continue;
      found.push({ kind: p.kind, phrase: m[0], index: m.index });
    }
  }
  found.sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length);
  const out: DealCue[] = [];
  for (const c of found) {
    const prev = out[out.length - 1];
    if (prev && c.index < prev.index + prev.phrase.length) continue;
    out.push(c);
  }
  return out;
}

/** What the cue says about the deal, as the end of a sentence about the message: "the message asks for a bulk or enterprise license". */
export const CUE_TEXT: Record<DealCueKind, string> = {
  enterprise_license: 'asks for a bulk or enterprise license',
  full_dataset: 'asks for the full dataset',
  broad_coverage: 'asks for national coverage',
  multi_year: 'asks for a multi-year term',
  multi_entity: 'covers several entities',
  approved_budget: 'says the budget is approved',
};

/** One cue as a reason or brief clause: `asks for a bulk or enterprise license ("bulk license")`. */
export const cueClause = (c: DealCue) => `${CUE_TEXT[c.kind]} ("${c.phrase}")`;
