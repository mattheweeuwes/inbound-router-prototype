// A temporal-expression parser for lead messages. It turns phrases like "mid-January", "in two weeks", "Q1 renewals" or "ASAP" into
// concrete dates relative to when the lead was received (America/New_York), takes the earliest future one, and maps its horizon to an urgency.
// Deterministic and testable; no model involved. Dates the message gives always beat exploring wording.
import type { Urgency } from '../schema';
import { etParts } from '../time';

export type WhenKind = 'asap' | 'deadline' | 'budget' | 'exploring' | 'none';
export interface WhenMatch { text: string; kind: 'asap' | 'date' | 'budget' | 'exploring'; date?: string; days?: number }
export interface WhenResult {
  horizonDays: number | null; // days from receivedAt to the earliest future date; 0 for asap
  kind: WhenKind;
  cue: string | null;         // the phrase that decided it
  date: string | null;        // ISO date (yyyy-mm-dd) of the deciding expression, when it has one
  matches: WhenMatch[];
}

/** Horizon thresholds, in days: within a quarter is now, within two quarters is this quarter, beyond that is exploring. */
export const NOW_DAYS = 92;
export const QUARTER_DAYS = 183;

const DAY = 86_400_000;
const dn = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const ymd = (n: number) => { const t = new Date(n * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const iso = (n: number) => { const { y, m, d } = ymd(n); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const validDate = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m);

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const MONTH_RE = 'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec';
const WEEKDAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const WEEKDAY_RE = 'sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat';
const NUMWORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, few: 3, 'a few': 3, couple: 2, 'a couple': 2, 'a couple of': 2, 'couple of': 2, several: 3 };
const NUM = '(?:\\d+|a couple of|couple of|a couple|a few|several|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few|an|a)';
const UNIT = '(day|week|month|year)s?';
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
const SEASONS: Record<string, [number, number]> = { spring: [3, 20], summer: [6, 21], fall: [9, 22], autumn: [9, 22], winter: [12, 21] };

const num = (t: string) => (/^\d+$/.test(t) ? Number(t) : (NUMWORDS[t.trim()] ?? NaN));

/** Day number of the nth weekday (0=Sun) of a month; n=-1 for the last one. */
function nthWeekday(y: number, m: number, wd: number, n: number): number {
  if (n > 0) {
    const first = dn(y, m, 1), firstWd = new Date(first * DAY).getUTCDay();
    return first + ((wd - firstWd + 7) % 7) + (n - 1) * 7;
  }
  const last = dn(y, m, lastDay(y, m)), lastWd = new Date(last * DAY).getUTCDay();
  return last - ((lastWd - wd + 7) % 7);
}

export function parse(text: string, receivedAt: string | number | Date): WhenResult {
  const orig = String(text ?? '');
  let s = orig.replace(/[A-Z]/g, c => c.toLowerCase()); // ASCII lowercase keeps indexes aligned with the original
  const p = etParts(new Date(receivedAt));
  const today = dn(p.y, p.mo, p.d), Y = p.y, M = p.mo, dow = p.dow;
  const matches: WhenMatch[] = [];
  const lower = s;

  const blank = (i: number, len: number) => { s = s.slice(0, i) + ' '.repeat(len) + s.slice(i + len); };
  const slice = (i: number, len: number) => orig.slice(i, i + len).trim().replace(/[.,;]+$/, '');
  type Hit = { days?: number; date?: number; kind?: WhenMatch['kind'] } | null | undefined;
  function take(re: RegExp, fn: (m: RegExpExecArray) => Hit) {
    const found: RegExpExecArray[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) { if (!m[0].length) { re.lastIndex++; continue; } found.push(m); }
    for (const m of found) {
      const h = fn(m);
      if (!h) continue;
      const kind = h.kind ?? 'date';
      const entry: WhenMatch = { text: slice(m.index, m[0].length), kind };
      if (h.date !== undefined) { entry.date = iso(h.date); entry.days = h.date - today; }
      else if (h.days !== undefined) { entry.days = h.days; entry.date = iso(today + h.days); }
      matches.push(entry);
      blank(m.index, m[0].length);
    }
  }
  const strip = (re: RegExp) => { re.lastIndex = 0; for (let m = re.exec(s); m; m = re.exec(s)) { if (!m[0].length) { re.lastIndex++; continue; } blank(m.index, m[0].length); re.lastIndex = m.index + m[0].length; } };
  const before = (idx: number, n = 14) => lower.slice(Math.max(0, idx - n), idx);

  // ---- 0. marketing imperatives are not deadlines ("click here asap", "act now", "reply now")
  strip(/\bclick\b[^.!?\n]{0,25}?\b(?:now|asap|today|immediately|fast|quickly|right away)\b/g);
  strip(/\b(?:act|buy|claim|subscribe|sign ?up|donate|hurry|reply|respond|call|text|email|contact|message|book|schedule|order|apply|register|join|download)\s+(?:me\s+|us\s+|here\s+)?now\b/g);

  // "today" describing the present ("we use Signal today", "than today", "as of today", "today's rates") is not a deadline
  strip(/\b(?:use|uses|using|run|runs|running|rely on|relies on|have|has|work with|works with|pay for|paying for|as of|than|versus|vs\.?|from|compared to)\b(?:\s+\S+){0,3}?\s+today\b/g);
  strip(/\btoday['\u2019]s\b/g);

  // ---- 1. exploring and no-rush language. Taken first so "no rush" and "not urgent" can never read as urgency.
  const NEG_BUDGET = /\b(?:no|not|without|zero|lack(?:ing)?)\s+(?:a\s+|any\s+|real\s+)?(?:\w+\s+)?budget\b/g;
  take(NEG_BUDGET, () => ({ kind: 'exploring', days: undefined }));
  take(/\b(?:no rush|no hurry|in no hurry|not in a hurry|not in any hurry|no need to rush|nothing urgent|not urgent(?:ly)?|not an urgent|not asap|not a rush|not rushed|no urgency|not time[- ]sensitive|no timeline|no specific (?:timeline|timeframe|project)|no project(?: yet)?|nothing specific|nothing in particular|future project|just looking|just browsing|just interested|poking around|kicking the tires|reading up|curious|exploring|explore|exploratory|researching|early[- ]stage|someday|eventually|down the road|learning more|evaluating|testing|not sure yet)\b/g, () => ({ kind: 'exploring' }));

  // ---- 2. asap words
  take(/\basap\b|\ba\.s\.a\.p\.?|\burgent(?:ly)?\b(?!\s+care)|\bimmediately\b|\bright away\b|\bright now\b|\bas soon as (?:possible|we can|you can)\b|\bfast\b(?!-)|\bquickly\b|\bin a hurry\b|\btime[- ]sensitive\b/g, () => ({ kind: 'asap', days: 0 }));

  // ---- 3. numeric dates: M/D, M/D/YYYY, ISO
  take(/(?<![\d/.-])(20\d\d)-(\d{2})-(\d{2})(?![\d])/g, m => {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!validDate(y, mo, d)) return null;
    const t = dn(y, mo, d); return t >= today ? { date: t } : null;
  });
  take(/(?<![\d/.$-])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])(?!\s*(?:of\b|million|billion|th\b|%|hour|hr\b|mile|inch|k\b))/g, m => {
    const mo = +m[1], d = +m[2];
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (!validDate(y, mo, d)) return null;
      const t = dn(y, mo, d); return t >= today ? { date: t } : null;
    }
    if (!validDate(Y, mo, d) && !validDate(Y + 1, mo, d)) return null;
    let t = validDate(Y, mo, d) ? dn(Y, mo, d) : -1;
    if (t < today) t = validDate(Y + 1, mo, d) ? dn(Y + 1, mo, d) : -1;
    return t >= today ? { date: t } : null;
  });

  // ---- 4. end of <quarter>, quarters, halves
  const quarterBounds = (y: number, q: number) => ({ start: dn(y, (q - 1) * 3 + 1, 1), end: dn(y, q * 3, lastDay(y, q * 3)) });
  const curQ = Math.floor((M - 1) / 3) + 1;
  const yearWord = (w: string | undefined): number | null => (!w ? null : /^20\d\d$/.test(w) ? +w : /next/.test(w) ? Y + 1 : /this/.test(w) ? Y : null);
  const QW: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
  function quarterHit(q: number, yr: number | null, end: boolean): Hit {
    if (yr != null) { const b = quarterBounds(yr, q); const t = end ? b.end : b.start; return t >= today ? { date: t } : (b.end >= today ? { date: today } : null); }
    const b = quarterBounds(Y, q);
    if (end) return b.end >= today ? { date: b.end } : { date: quarterBounds(Y + 1, q).end };
    if (b.start >= today) return { date: b.start };
    if (b.end >= today) return { date: today }; // we are inside that quarter now
    return { date: quarterBounds(Y + 1, q).start };
  }
  take(/\bend of (?:the )?q([1-4])\b(?:\s+(?:of\s+)?(20\d\d|next year|this year))?/g, m => quarterHit(+m[1], yearWord(m[2]), true));
  take(/\b(?:end of (?:the )?quarter|quarter[- ]end)\b/g, () => ({ date: quarterBounds(Y, curQ).end }));
  take(/\bend of next quarter\b/g, () => { const nq = curQ === 4 ? 1 : curQ + 1; return { date: quarterBounds(curQ === 4 ? Y + 1 : Y, nq).end }; });
  take(/\bthis quarter\b/g, () => ({ date: quarterBounds(Y, curQ).end }));
  take(/\bnext quarter\b/g, () => ({ date: quarterBounds(curQ === 4 ? Y + 1 : Y, curQ === 4 ? 1 : curQ + 1).start }));
  take(/\bq([1-4])\b(?:\s*(?:of\s+)?(20\d\d|next year|this year))?/g, m => quarterHit(+m[1], yearWord(m[2]), false));
  take(/\b(first|second|third|fourth|1st|2nd|3rd|4th) quarter\b(?:\s+(?:of\s+)?(20\d\d|next year|this year))?/g, m => quarterHit(QW[m[1]], yearWord(m[2]), false));
  take(/\b(?:h([12])|(first|second) half)\b(?:\s+(?:of\s+)?(20\d\d|next year|this year))?/g, m => {
    const h = m[1] ? +m[1] : (m[2] === 'first' ? 1 : 2), yr = yearWord(m[3]);
    const start = (y: number) => dn(y, h === 1 ? 1 : 7, 1), end = (y: number) => dn(y, h === 1 ? 6 : 12, h === 1 ? 30 : 31);
    const y = yr ?? Y;
    if (start(y) >= today) return { date: start(y) };
    if (end(y) >= today) return { date: today };
    return yr == null ? { date: start(Y + 1) } : null;
  });

  // ---- 5. months, with an optional qualifier, day and year
  // day first: "15th of January", "15 January 2027"
  take(new RegExp(`\\b(?:the\\s+)?(\\d{1,2})(st|nd|rd|th)?\\s+(of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(20\\d\\d))?`, 'g'), m => {
    const d = +m[1], mo = MONTHS[m[4]];
    if (d < 1 || d > 31 || (m[4].length <= 3 && !m[2] && !m[3])) return null;
    if (m[5]) { const y = +m[5]; if (!validDate(y, mo, d)) return null; const t = dn(y, mo, d); return t >= today ? { date: t } : null; }
    for (const y of [Y, Y + 1]) if (validDate(y, mo, d) && dn(y, mo, d) >= today) return { date: dn(y, mo, d) };
    return null;
  });
  const MONTH_RX = new RegExp(`\\b(?:(early|mid|late|end of|beginning of|start of)[\\s-]+)?(${MONTH_RE})\\b\\.?(?:[\\s,]+(\\d{1,2})(?:st|nd|rd|th)?\\b)?(?:,?\\s+(?:(20\\d\\d)|(?:of\\s+)?(next year|this year)))?`, 'g');
  const PREPS = /(?:\b(?:in|by|before|until|till|through|thru|during|around|for|from|of|after|since|on|about|this|next|and|or|to|the)\s+)$/;
  take(MONTH_RX, m => {
    const word = m[2], qual = m[1], dayTxt = m[3], yearTxt = m[4], rel = m[5];
    const mo = MONTHS[word];
    const short = word.length <= 3 || word === 'sept';
    const hasPrep = !!qual || PREPS.test(before(m.index, 14)) || m.index === 0 || /[.!?]\s*$/.test(before(m.index, 4));
    if ((short || word === 'may') && !dayTxt && !yearTxt && !rel && !hasPrep) return null;
    if (word === 'may' && !dayTxt && !yearTxt && !rel) {
      const after = lower.slice(m.index + m[0].length, m.index + m[0].length + 14);
      if (/^\s+(?:be|have|has|need|want|also|not|like|get|become|start|help|take|require|include|consider|choose|prefer|decide|ask|go)\b/.test(after)) return null;
      if (!qual && !/\b(?:in|by|before|until|till|during|around|of|since|this|next|early|mid|late)\s+$/.test(before(m.index, 12))) return null;
    }
    // "march 20" is a day; "march 2028" is a year (the day group needs a word boundary, so 2028 never splits)
    let d = dayTxt ? +dayTxt : undefined;
    if (d !== undefined && (d < 1 || d > 31)) d = undefined;
    const explicitYear = yearTxt ? +yearTxt : rel ? yearWord(rel) : null;
    const dayFor = (y: number): number => {
      if (d !== undefined) return d;
      switch (qual) {
        case 'early': return 5; case 'mid': return 15; case 'late': return 25;
        case 'end of': return lastDay(y, mo);
        default: return 1;
      }
    };
    if (explicitYear != null) {
      const day = Math.min(dayFor(explicitYear), lastDay(explicitYear, mo));
      const t = dn(explicitYear, mo, day);
      if (t >= today) return { date: t };
      return dn(explicitYear, mo, lastDay(explicitYear, mo)) >= today ? { date: today } : null;
    }
    const day0 = Math.min(dayFor(Y), lastDay(Y, mo));
    const cand = dn(Y, mo, day0);
    if (cand >= today) return { date: cand };
    // the named month is the current one and its marker has passed: it is happening now (unless an explicit day was given)
    if (mo === M && d === undefined) return { date: today };
    if (mo === M && d !== undefined && qual) return { date: today };
    const ny = Y + 1;
    return { date: dn(ny, mo, Math.min(dayFor(ny), lastDay(ny, mo))) };
  });

  // ---- 6. relative offsets: today, tomorrow, weekdays, in N units, this/next week/month, end of month/week/year
  take(/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/g, () => ({ days: 0 }));
  take(/\btomorrow\b/g, () => ({ days: 1 }));
  const unitMatch = (t1: string, t2: string | undefined, unit: string): number | null => {
    const a = num(t1), b = t2 ? num(t2) : NaN;
    const n = Number.isNaN(a) ? NaN : (Number.isNaN(b) ? a : Math.min(a, b)); // a range takes its lower bound
    return Number.isNaN(n) ? null : n * UNIT_DAYS[unit];
  };
  const RANGE = `(?:\\s*(?:to|-|–|or)\\s*(${NUM}))?`;
  take(new RegExp(`\\b(?:in|within|inside)\\s+(?:the\\s+(?:next|coming)\\s+)?(${NUM})${RANGE}[\\s-]*${UNIT}\\b`, 'g'), m => { const d = unitMatch(m[1], m[2], m[3]); return d == null ? null : { days: d }; });
  take(new RegExp(`\\b(?:over\\s+)?(?:the\\s+)?next\\s+(${NUM})${RANGE}[\\s-]*${UNIT}\\b`, 'g'), m => { const d = unitMatch(m[1], m[2], m[3]); return d == null ? null : { days: d }; });
  take(new RegExp(`\\b(${NUM})${RANGE}[\\s-]*${UNIT}\\s+(?:from now|from today|out|away|left|remaining|to go)\\b`, 'g'), m => { const d = unitMatch(m[1], m[2], m[3]); return d == null ? null : { days: d }; });
  take(new RegExp(`\\b(?:have|got|only|just)\\s+(${NUM})${RANGE}[\\s-]*(day|week|month)s?\\b`, 'g'), m => { const d = unitMatch(m[1], m[2], m[3]); return d == null ? null : { days: d }; });
  take(new RegExp(`\\b(next|this|on|by|before|until|till)\\s+(${WEEKDAY_RE})\\b`, 'g'), m => {
    const wd = WEEKDAYS[m[2]]; const upcoming = (wd - dow + 7) % 7;
    return { days: m[1] === 'next' ? (upcoming || 7) : upcoming };
  });
  take(/\b(?:this weekend)\b/g, () => ({ days: dow === 6 || dow === 0 ? 0 : 6 - dow }));
  take(/\b(?:this week|end of (?:the |this )?week)\b/g, () => ({ days: dow >= 1 && dow <= 5 ? 5 - dow : 0 }));
  take(/\bnext week\b/g, () => ({ days: ((1 - dow + 7) % 7) || 7 }));
  take(/\bend of next month\b/g, () => { const y = M === 12 ? Y + 1 : Y, mo = M === 12 ? 1 : M + 1; return { date: dn(y, mo, lastDay(y, mo)) }; });
  take(/\bnext month\b/g, () => ({ date: dn(M === 12 ? Y + 1 : Y, M === 12 ? 1 : M + 1, 1) }));
  take(/\b(?:end of (?:the |this )?month|this month|month[- ]end|by month end)\b/g, () => ({ date: dn(Y, M, lastDay(Y, M)) }));
  take(/\b(?:end of (?:the |this )?year|year[- ]end|this year|by the end of the year)\b/g, () => ({ date: dn(Y, 12, 31) }));
  take(/\b(?:end of next year)\b/g, () => ({ date: dn(Y + 1, 12, 31) }));
  take(/\b(?:(?:start|beginning) of next year)\b/g, () => ({ date: dn(Y + 1, 1, 1) }));
  take(/\b(early|mid|late)(?:[\s-]+in)?[\s-]+next year\b/g, m => ({ date: dn(Y + 1, m[1] === 'early' ? 2 : m[1] === 'mid' ? 7 : 10, 1) }));
  take(/\bnext year\b/g, () => ({ date: dn(Y + 1, 7, 1) }));

  // ---- 7. seasons and holidays
  take(/\b(?:(next|this|early|late|mid)[\s-]+)?(spring|summer|fall|autumn|winter)\b(?!\s+(?:short|behind|back|through|apart|off|out|into|under|flat|in love))/g, m => {
    if (m[2] === 'fall' && !m[1] && !/\b(?:in|by|before|until|during|the|for|of|this|next|early|late|mid|every|each|last)\s+$/.test(before(m.index, 12))) return null;
    const [mo, d] = SEASONS[m[2]];
    const order = ['spring', 'summer', 'fall', 'winter'], key = m[2] === 'autumn' ? 'fall' : m[2], i = order.indexOf(key);
    const startOf = (y: number) => dn(y, mo, d);
    const endOf = (y: number) => (i === 3 ? dn(y + 1, SEASONS.spring[0], SEASONS.spring[1]) : dn(y, SEASONS[order[i + 1]][0], SEASONS[order[i + 1]][1])) - 1;
    if (m[1] !== 'next' && [Y - 1, Y].some(y => today >= startOf(y) && today <= endOf(y))) return { date: today }; // we are in that season now
    return { date: startOf(startOf(Y) >= today ? Y : Y + 1) };
  });
  const nextHoliday = (f: (y: number) => number): number => { const a = f(Y); return a >= today ? a : f(Y + 1); };
  take(/\bthanksgiving\b/g, () => ({ date: nextHoliday(y => nthWeekday(y, 11, 4, 4)) }));
  take(/\bchristmas\b/g, () => ({ date: nextHoliday(y => dn(y, 12, 25)) }));
  take(/\bnew year'?s?(?: day| eve)?\b/g, () => ({ date: nextHoliday(y => dn(y + 0, 1, 1)) }));
  take(/\blabor day\b/g, () => ({ date: nextHoliday(y => nthWeekday(y, 9, 1, 1)) }));
  take(/\bmemorial day\b/g, () => ({ date: nextHoliday(y => nthWeekday(y, 5, 1, -1)) }));

  // ---- 8. ordinal days: "the 1st", "by the 15th" = the next such day
  take(/\b(?:the|on|by|before|until|till|around)\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:quarter|half|time|party|choice|place|round|floor|priority|week|year|month))/g, m => {
    const d = +m[1];
    if (d < 1 || d > 31) return null;
    let y = Y, mo = M;
    for (let i = 0; i < 14; i++) {
      if (validDate(y, mo, d) && dn(y, mo, d) >= today) return { date: dn(y, mo, d) };
      mo++; if (mo > 12) { mo = 1; y++; }
    }
    return null;
  });

  // ---- 9. bare years. Plan-year and renewal wording points at January 1; otherwise mid-year.
  take(/(?<![\d,.$/-])\b(20[2-4]\d)\b(?![\d,%/])/g, m => {
    const y = +m[1];
    const around = lower.slice(Math.max(0, m.index - 40), m.index + 45);
    const planYear = /(plan[- ]year|benefit year|coverage year|policy year|contract year|renewals?|renews?|open enrollment|effective)/.test(around);
    const options = planYear ? [dn(y, 1, 1), dn(y, 7, 1), dn(y, 12, 31)] : [dn(y, 7, 1), dn(y, 12, 31)];
    const t = options.find(o => o >= today);
    return t == null ? null : { date: t };
  });

  // ---- 10. budget and planning language with no date of its own
  const budgetRe = /\b(?:budget(?:s|ing|ed)?|planning cycle|planning season|annual planning|fiscal year|fiscal|fy ?\d{0,4}|rate filings?|annual plan|strategic plan(?:ning)?|planning)\b/g;
  const budgetHits: WhenMatch[] = [];
  const negBudget = new RegExp(NEG_BUDGET.source, 'g');
  const negRanges: [number, number][] = []; for (let m = negBudget.exec(lower); m; m = negBudget.exec(lower)) negRanges.push([m.index, m.index + m[0].length]);
  for (let m = budgetRe.exec(lower); m; m = budgetRe.exec(lower)) {
    if (negRanges.some(([a, b]) => m!.index >= a && m!.index < b)) continue;
    budgetHits.push({ text: slice(m.index, m[0].length), kind: 'budget' });
  }

  // ---- decide
  const asap = matches.filter(x => x.kind === 'asap');
  const dated = matches.filter(x => x.kind === 'date' && x.days !== undefined && x.days >= 0).sort((a, b) => a.days! - b.days!);
  const exploring = matches.filter(x => x.kind === 'exploring' && !/budget/i.test(x.text));
  const rank = (m: WhenMatch) => (m.kind === 'asap' ? -2 : m.kind === 'date' ? (m.days ?? 1e9) : 1e9);
  const all: WhenMatch[] = [...matches].sort((a, b) => rank(a) - rank(b)).concat(budgetHits);
  if (asap.length) return { horizonDays: 0, kind: 'asap', cue: asap[0].text, date: iso(today), matches: all };
  if (dated.length) {
    const e = dated[0];
    if (budgetHits.length && e.days! > NOW_DAYS) return { horizonDays: e.days!, kind: 'budget', cue: budgetHits[0].text, date: e.date ?? null, matches: all };
    return { horizonDays: e.days!, kind: 'deadline', cue: e.text, date: e.date ?? null, matches: all };
  }
  if (budgetHits.length) return { horizonDays: null, kind: 'budget', cue: budgetHits[0].text, date: null, matches: all };
  if (exploring.length || matches.some(x => x.kind === 'exploring')) return { horizonDays: null, kind: 'exploring', cue: (exploring[0] ?? matches.find(x => x.kind === 'exploring')!).text, date: null, matches: all };
  return { horizonDays: null, kind: 'none', cue: null, date: null, matches: all };
}

/** asap and horizons within a quarter are now; within two quarters this_quarter; beyond that exploring. Budget language alone is this_quarter. */
export function urgencyFromWhen(w: WhenResult): Urgency | null {
  switch (w.kind) {
    case 'asap': return 'now';
    case 'deadline': return w.horizonDays! <= NOW_DAYS ? 'now' : w.horizonDays! <= QUARTER_DAYS ? 'this_quarter' : 'exploring';
    case 'budget': return 'this_quarter';
    case 'exploring': return 'exploring';
    default: return null;
  }
}
