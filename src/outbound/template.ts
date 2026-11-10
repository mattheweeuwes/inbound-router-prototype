// The machinery every outbound draft shares: a template with {placeholders}, filled from named values, rendered both as a
// finished string and as runs, with every inserted value recorded beside the field it came from. The platform play's drafts
// (draft.ts) and the system-gap play's (systemGapDraft.ts) are both built with it, so the rule that code inserts every
// figure, and the cockpit's marking of each one where it stands, hold for both. {first_name} stays a placeholder.

/** The placeholders left for a person to fill. */
export const OPEN_PLACEHOLDERS = ['{first_name}'];

export interface InsertedValue { placeholder: string; value: string; field: string }

/**
 * One run of a rendered text. Plain text has only `text`; a value code inserted names its `placeholder`; a placeholder left
 * for a person to fill (`{first_name}`) also has `open`. The cockpit marks inserted values from these runs, so it never has
 * to find a figure in the finished text by searching for it.
 */
export interface Part { text: string; placeholder?: string; open?: boolean }

/** A value for each placeholder name, with the field it came from. */
export type Values = Record<string, { value: string; field: string }>;

/** Fills each {placeholder} from values and records it once, in order of first use. {first_name} is left as it is. */
export function fill(template: string, values: Values, used: Map<string, InsertedValue>): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const whole = m[0];
    if (m.index > at) parts.push({ text: template.slice(at, m.index) });
    at = m.index + whole.length;
    if (OPEN_PLACEHOLDERS.includes(whole)) { parts.push({ text: whole, placeholder: whole, open: true }); continue; }
    const v = values[m[1]];
    if (!v) throw new Error(`no value for ${whole}`);
    if (!used.has(m[1])) used.set(m[1], { placeholder: whole, value: v.value, field: v.field });
    parts.push({ text: v.value, placeholder: whole });
  }
  if (at < template.length) parts.push({ text: template.slice(at) });
  return parts;
}

export const textOf = (parts: Part[]): string => parts.map(p => p.text).join('');
/** The runs of several pieces with a separator run between them. */
export const joinParts = (pieces: Part[][], separator: string): Part[] => pieces.flatMap((p, i) => (i ? [{ text: separator }, ...p] : p));
