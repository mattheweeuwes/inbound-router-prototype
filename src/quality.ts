// GTM data-quality scorecard: named controls, a count for each, every number computed from stored rows.
// Read-only by construction: every query below is a single SELECT (a test enforces it), and nothing here
// writes, creates a view or changes a pragma. The same code serves the CLI (opened read-only), /api/quality and the cockpit.
import type { Db } from './db';

export type Grain = 'event' | 'lead' | 'account' | 'stage';
export type Unit = 'count' | 'hours' | 'ms';

export interface BreakdownRow {
  label: string;
  value: number | null;
  numerator?: number;
  denominator?: number;
  /** sample size behind a percentile */
  n?: number;
}

export interface Control {
  id: string;
  name: string;
  /** one sentence, states the grain (event, lead, account or stage) */
  definition: string;
  grain: Grain;
  /** 'window': limited by sinceDays; 'current': a state measure that ignores the window */
  scope: 'window' | 'current';
  unit: Unit;
  /** the exact query that was run (whitespace collapsed) */
  sql: string;
  /** the named parameters bound to it */
  params: Record<string, string | number>;
  value: number | null;
  numerator?: number;
  denominator?: number;
  breakdown?: BreakdownRow[];
}

export interface Scorecard {
  title: string;
  generatedAt: string;
  /** null when the whole history is scored */
  sinceDays: number | null;
  /** ISO start of the window, or null; the window is measured back from the newest stored event, not from the wall clock */
  windowStart: string | null;
  controls: Control[];
}

export interface ScorecardOptions {
  /** score only events received in the last N days before the newest stored event */
  sinceDays?: number;
  /** clock override (ms since epoch); only the open-review age and generatedAt use it */
  now?: number;
}

type Row = Record<string, unknown>;
interface Shape { value: number | null; numerator?: number; denominator?: number; breakdown?: BreakdownRow[] }
interface Def {
  id: string; name: string; definition: string; grain: Grain; scope: 'window' | 'current'; unit?: Unit;
  sql: string;
  shape: (rows: Row[]) => Shape;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v == null ? 0 : Number(v));
const sum = (rows: Row[], key: string) => rows.reduce((a, r) => a + num(r[key]), 0);
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

// ---- shared query fragments ------------------------------------------------
const LEADS = `FROM leads l JOIN lead_events e ON e.id = l.id`;
const IN_WINDOW = `e.received_at >= $since`;
const ROUTED = `l.route_action IS NOT NULL`;
const SPAM_OR_DISPOSABLE = `(l.is_disposable = 1 OR json_extract(l.qualification_json, '$.final.disqualifier') = 'spam')`;

/** One count of routed leads for a single route action, over all routed leads in the window. */
function zombie(id: string, name: string, definition: string, cond: string): Def {
  return {
    id, name, definition, grain: 'lead', scope: 'window',
    sql: `SELECT COALESCE(SUM(${cond}), 0) AS n, COUNT(*) AS d ${LEADS} WHERE ${IN_WINDOW} AND ${ROUTED}`,
    shape: rows => ({ value: num(rows[0]?.n), numerator: num(rows[0]?.n), denominator: num(rows[0]?.d) }),
  };
}

/** A data-contract gap, counted per source: n lacking the field out of d normalized leads from that source. */
function gap(id: string, name: string, definition: string, missing: string): Def {
  return {
    id, name, definition, grain: 'lead', scope: 'window',
    sql: `SELECT e.source AS label, COALESCE(SUM(${missing}), 0) AS n, COUNT(*) AS d ${LEADS} WHERE l.normalized_json IS NOT NULL AND ${IN_WINDOW} GROUP BY e.source ORDER BY e.source`,
    shape: rows => ({
      value: sum(rows, 'n'), numerator: sum(rows, 'n'), denominator: sum(rows, 'd'),
      breakdown: rows.map(r => ({ label: String(r.label), value: num(r.n), numerator: num(r.n), denominator: num(r.d) })),
    }),
  };
}

/** Nearest-rank percentile of time_to_route_ms, overall and per tier: k = ceil(p * n / 100), the k-th smallest value. */
function timeToRoute(p: 50 | 90): Def {
  const base = `SELECT COALESCE(l.tier, 'unscored') AS g, l.time_to_route_ms AS ms ${LEADS} WHERE l.time_to_route_ms IS NOT NULL AND ${IN_WINDOW}`;
  return {
    id: `time_to_route_p${p}`,
    name: `Time to route, p${p}, by tier`,
    definition: `Lead grain: the nearest-rank ${p === 50 ? 'median' : '90th percentile'} of milliseconds from receipt to the routing decision, over all leads and then within each tier (X is a disqualified lead).`,
    grain: 'lead', scope: 'window', unit: 'ms',
    sql: `WITH t AS (${base} UNION ALL SELECT 'all' AS g, l.time_to_route_ms AS ms ${LEADS} WHERE l.time_to_route_ms IS NOT NULL AND ${IN_WINDOW}), `
      + `ranked AS (SELECT g, ms, ROW_NUMBER() OVER (PARTITION BY g ORDER BY ms) AS rn, COUNT(*) OVER (PARTITION BY g) AS n FROM t) `
      + `SELECT g AS label, ms AS value, n FROM ranked WHERE rn = (n * ${p} + 99) / 100 ORDER BY CASE g WHEN 'all' THEN 0 ELSE 1 END, g`,
    shape: rows => {
      const all = rows.find(r => r.label === 'all');
      return {
        value: all ? num(all.value) : null,
        breakdown: rows.filter(r => r.label !== 'all').map(r => ({ label: `Tier ${r.label}`, value: num(r.value), n: num(r.n) })),
      };
    },
  };
}

// A repeat contact, as the pipeline defines it: an earlier lead with the same contact_key, received in the 30 days before this one,
// finished, and not routed away as drop/careers/press. Same window arithmetic as src/pipeline.ts (string-compared ISO timestamps).
const EARLIER_LIVE_LEAD = `EXISTS (SELECT 1 FROM leads p JOIN lead_events pe ON pe.id = p.id
  WHERE p.contact_key = l.contact_key AND p.id != l.id AND pe.received_at < e.received_at
    AND pe.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ', e.received_at, '-30 days')
    AND p.status = 'done' AND COALESCE(p.route_action, '') NOT IN ('drop', 'careers', 'press'))`;

const DEFS: Def[] = [
  // ---- intake: event grain ------------------------------------------------
  {
    id: 'events_received', name: 'Events received', grain: 'event', scope: 'window',
    definition: 'Event grain: first deliveries stored in lead_events, one row per distinct inbound webhook or form event; re-deliveries are counted in the replay control, not here.',
    sql: `SELECT COUNT(*) AS n FROM lead_events e WHERE ${IN_WINDOW}`,
    shape: rows => ({ value: num(rows[0]?.n) }),
  },
  {
    id: 'events_stored_once', name: 'Events stored once', grain: 'event', scope: 'window',
    definition: 'Event grain: distinct (source, source_event_id) pairs out of stored event rows; equal numbers mean no event is stored twice.',
    sql: `SELECT COUNT(DISTINCT e.source || char(31) || e.source_event_id) AS distinct_keys, COUNT(*) AS row_count FROM lead_events e WHERE ${IN_WINDOW}`,
    shape: rows => ({ value: num(rows[0]?.distinct_keys), numerator: num(rows[0]?.distinct_keys), denominator: num(rows[0]?.row_count) }),
  },
  {
    id: 'idempotent_replays', name: 'Re-delivered events acknowledged without a second lead', grain: 'event', scope: 'window',
    definition: 'Event grain: stage_log rows of stage idempotent_replay, one per re-delivery of an already stored (source, source_event_id) that answered 200 and created nothing.',
    sql: `SELECT COUNT(*) AS n FROM stage_log s JOIN lead_events e ON e.id = s.lead_id WHERE s.stage = 'idempotent_replay' AND ${IN_WINDOW}`,
    shape: rows => ({ value: num(rows[0]?.n) }),
  },
  // ---- repeat contacts: lead grain ----------------------------------------
  {
    id: 'repeat_attached', name: 'Repeat contacts attached to their first lead', grain: 'lead', scope: 'window',
    definition: 'Lead grain: leads whose duplicate_of points at the first live lead of the same contact within the previous 30 days.',
    sql: `SELECT COUNT(*) AS n ${LEADS} WHERE l.duplicate_of IS NOT NULL AND ${IN_WINDOW}`,
    shape: rows => ({ value: num(rows[0]?.n) }),
  },
  {
    id: 'repeat_not_linked', name: 'Repeat contacts not linked to their first lead (should be 0)', grain: 'lead', scope: 'window',
    definition: 'Lead grain: leads that have an earlier live lead from the same contact in the previous 30 days but no duplicate_of, out of all such repeat leads.',
    sql: `SELECT COALESCE(SUM(l.duplicate_of IS NULL), 0) AS n, COUNT(*) AS d ${LEADS} WHERE l.contact_key IS NOT NULL AND ${IN_WINDOW} AND ${EARLIER_LIVE_LEAD}`,
    shape: rows => ({ value: num(rows[0]?.n), numerator: num(rows[0]?.n), denominator: num(rows[0]?.d) }),
  },
  // ---- zombie leads routed away from sales: lead grain --------------------
  zombie('zombie_spam_dropped', 'Spam or disposable-domain leads dropped',
    'Lead grain: routed leads dropped (route action drop) because the email domain is disposable or the message was classified as spam, out of all routed leads.',
    `(l.route_action = 'drop' AND ${SPAM_OR_DISPOSABLE})`),
  zombie('zombie_vendor_pitch_dropped', 'Vendor pitches dropped',
    'Lead grain: routed leads dropped (route action drop) with disqualifier vendor_pitch, out of all routed leads.',
    `(l.route_action = 'drop' AND json_extract(l.qualification_json, '$.final.disqualifier') = 'vendor_pitch')`),
  zombie('zombie_careers', 'Job seekers sent the careers reply',
    'Lead grain: routed leads with route action careers (disqualifier job_seeker), out of all routed leads.',
    `l.route_action = 'careers'`),
  zombie('zombie_press', 'Press inquiries forwarded to the press inbox',
    'Lead grain: routed leads with route action press (disqualifier media), out of all routed leads.',
    `l.route_action = 'press'`),
  zombie('zombie_competitor', 'Competitors flagged, no sales route',
    'Lead grain: routed leads with route action competitor_flag (competitor domain), out of all routed leads.',
    `l.route_action = 'competitor_flag'`),
  // ---- held for a person: lead grain --------------------------------------
  {
    id: 'review_open', name: 'Leads waiting for a person', grain: 'lead', scope: 'current',
    definition: 'Lead grain: review_queue rows not yet resolved, by the reason recorded when the lead was queued; current state, not limited by the window.',
    sql: `SELECT r.reason AS label, COUNT(*) AS n FROM review_queue r WHERE r.resolved = 0 GROUP BY r.reason ORDER BY r.reason`,
    shape: rows => ({ value: sum(rows, 'n'), breakdown: rows.map(r => ({ label: String(r.label), value: num(r.n) })) }),
  },
  {
    id: 'review_resolved', name: 'Leads a person has resolved', grain: 'lead', scope: 'window',
    definition: 'Lead grain: review_queue rows marked resolved, by reason, for leads received in the window.',
    sql: `SELECT r.reason AS label, COUNT(*) AS n FROM review_queue r JOIN lead_events e ON e.id = r.lead_id WHERE r.resolved = 1 AND ${IN_WINDOW} GROUP BY r.reason ORDER BY r.reason`,
    shape: rows => ({ value: sum(rows, 'n'), breakdown: rows.map(r => ({ label: String(r.label), value: num(r.n) })) }),
  },
  {
    id: 'review_oldest_open_hours', name: 'Oldest open review item, hours', grain: 'lead', scope: 'current', unit: 'hours',
    definition: 'Lead grain: hours between the oldest unresolved review_queue row being created and the time this scorecard was generated (empty when nothing is open).',
    sql: `SELECT MAX(0, ROUND((julianday($now) - julianday(MIN(r.created_at))) * 24, 1)) AS n FROM review_queue r WHERE r.resolved = 0`,
    shape: rows => ({ value: rows[0]?.n == null ? null : num(rows[0].n) }),
  },
  {
    id: 'llm_only_to_review', name: 'Model-only disqualifiers cleared to review', grain: 'lead', scope: 'window',
    definition: 'Lead grain: leads where only the model said non-buyer (spam or vendor pitch at any confidence, anything else below 0.8), so the disqualifier was cleared and the lead queued with reason llm_only_disqualifier, out of all routed leads.',
    sql: `SELECT (SELECT COUNT(*) FROM review_queue r JOIN lead_events e ON e.id = r.lead_id WHERE r.reason = 'llm_only_disqualifier' AND ${IN_WINDOW}) AS n, `
      + `(SELECT COUNT(*) ${LEADS} WHERE ${IN_WINDOW} AND ${ROUTED}) AS d`,
    shape: rows => ({ value: num(rows[0]?.n), numerator: num(rows[0]?.n), denominator: num(rows[0]?.d) }),
  },
  // ---- account resolution: lead grain -------------------------------------
  {
    id: 'resolution_by_method', name: 'Leads resolved to an account, by method', grain: 'lead', scope: 'window',
    definition: 'Lead grain: leads whose resolution_json status is resolved, split by the method that placed them, out of all leads that reached the resolve stage.',
    sql: `SELECT json_extract(l.resolution_json, '$.method') AS method, json_extract(l.resolution_json, '$.status') AS status, COUNT(*) AS n ${LEADS} WHERE l.resolution_json IS NOT NULL AND ${IN_WINDOW} GROUP BY 1, 2 ORDER BY n DESC, method`,
    shape: rows => {
      const resolved = rows.filter(r => r.status === 'resolved');
      return {
        value: sum(resolved, 'n'), numerator: sum(resolved, 'n'), denominator: sum(rows, 'n'),
        breakdown: resolved.map(r => ({ label: String(r.method), value: num(r.n) })),
      };
    },
  },
  {
    id: 'unresolved_leads', name: 'Leads left unresolved', grain: 'lead', scope: 'window',
    definition: 'Lead grain: leads whose resolution_json status is unresolved or ambiguous, shown with the route action each one ended in, out of all leads that reached the resolve stage.',
    sql: `SELECT json_extract(l.resolution_json, '$.status') AS status, COALESCE(l.route_action, 'pending') AS action, COUNT(*) AS n ${LEADS} WHERE l.resolution_json IS NOT NULL AND ${IN_WINDOW} GROUP BY 1, 2 ORDER BY n DESC, status, action`,
    shape: rows => {
      const left = rows.filter(r => r.status !== 'resolved');
      return {
        value: sum(left, 'n'), numerator: sum(left, 'n'), denominator: sum(rows, 'n'),
        breakdown: left.map(r => ({ label: `${r.status} / ${r.action}`, value: num(r.n) })),
      };
    },
  },
  // ---- data-contract gaps, per source: lead grain -------------------------
  gap('gap_missing_email', 'Leads missing an email, by source',
    'Lead grain: normalized leads with no email, per inbound source, out of that source\'s normalized leads (web_intent is account-level and has no person, so it is expected here).',
    `(l.email IS NULL OR TRIM(l.email) = '')`),
  gap('gap_missing_company', 'Leads missing a company, by source',
    'Lead grain: normalized leads with neither a company domain nor a company name, per inbound source, out of that source\'s normalized leads (a free-mail address has no company domain).',
    `(l.company_domain IS NULL AND (l.company_name_raw IS NULL OR TRIM(l.company_name_raw) = ''))`),
  gap('gap_missing_utm_source', 'Leads missing a utm_source, by source',
    'Lead grain: normalized leads with no utm_source after normalization, per inbound source, out of that source\'s normalized leads (several doors carry no UTMs by design).',
    `(l.utm_source IS NULL OR TRIM(l.utm_source) = '')`),
  // ---- accounts: account grain --------------------------------------------
  {
    id: 'accounts_no_owner', name: 'Active accounts with no owner', grain: 'account', scope: 'current',
    definition: 'Account grain: accounts in v_account_scores with leads in the last 30 days (measured back from the newest event) that have no accounts.owner and no lead routed under rule R5, which is how a CRM-mirror owner shows up; the breakdown also gives the stricter owner-column-only count.',
    sql: `SELECT COALESCE(SUM(v.owner IS NULL AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.account_id = v.account_key AND json_extract(l.route_json, '$.rule') = 'R5')), 0) AS no_owner_anywhere, `
      + `COALESCE(SUM(v.owner IS NULL), 0) AS no_owner_column, COALESCE(SUM(v.owner IS NOT NULL), 0) AS owner_column, COUNT(*) AS active FROM v_account_scores v WHERE v.leads_30d > 0`,
    shape: rows => {
      const r = rows[0] ?? {};
      return {
        value: num(r.no_owner_anywhere), numerator: num(r.no_owner_anywhere), denominator: num(r.active),
        breakdown: [
          { label: 'owner on the account row', value: num(r.owner_column) },
          { label: 'owner only via CRM mirror (rule R5)', value: num(r.no_owner_column) - num(r.no_owner_anywhere) },
          { label: 'no owner anywhere', value: num(r.no_owner_anywhere) },
        ],
      };
    },
  },
  // ---- speed: lead grain --------------------------------------------------
  timeToRoute(50),
  timeToRoute(90),
  // ---- stage failures: stage grain ----------------------------------------
  {
    id: 'stage_failures', name: 'Stage failures, by stage', grain: 'stage', scope: 'window',
    definition: 'Stage grain: stage_log rows with ok = 0 out of all rows logged for that stage (a row per lead per run); a stage named pipeline is the outer catch-all for a lead that failed.',
    sql: `SELECT s.stage AS label, COALESCE(SUM(s.ok = 0), 0) AS n, COUNT(*) AS d FROM stage_log s JOIN lead_events e ON e.id = s.lead_id `
      + `WHERE s.stage != 'idempotent_replay' AND ${IN_WINDOW} GROUP BY s.stage `
      + `ORDER BY CASE s.stage WHEN 'normalize' THEN 1 WHEN 'resolve' THEN 2 WHEN 'qualify' THEN 3 WHEN 'score' THEN 4 WHEN 'route' THEN 5 WHEN 'notify' THEN 6 WHEN 'crm' THEN 7 ELSE 8 END, s.stage`,
    shape: rows => ({
      value: sum(rows, 'n'), numerator: sum(rows, 'n'), denominator: sum(rows, 'd'),
      breakdown: rows.map(r => ({ label: String(r.label), value: num(r.n), numerator: num(r.n), denominator: num(r.d) })),
    }),
  },
];

export const CONTROL_IDS = DEFS.map(d => d.id);

export function computeScorecard(db: Db, opts: ScorecardOptions = {}): Scorecard {
  const nowMs = opts.now ?? Date.now();
  const sinceDays = opts.sinceDays == null ? null : opts.sinceDays;
  if (sinceDays != null && !(Number.isFinite(sinceDays) && sinceDays > 0)) throw new Error('sinceDays must be a positive number');
  // The window is anchored on the newest stored event, like v_account_scores, so replayed history still has a window and the numbers are repeatable.
  const anchor = (db.prepare(`SELECT MAX(received_at) AS t FROM lead_events`).get() as { t: string | null }).t;
  const windowStart = sinceDays != null && anchor ? new Date(Date.parse(anchor) - sinceDays * 86_400_000).toISOString() : null;
  const bind = { since: windowStart ?? '', now: new Date(nowMs).toISOString() };

  const controls: Control[] = DEFS.map(def => {
    const sql = collapse(def.sql);
    const params: Record<string, string | number> = {};
    for (const k of Object.keys(bind) as (keyof typeof bind)[]) if (sql.includes(`$${k}`)) params[k] = bind[k];
    const rows = db.prepare(sql).all(params) as Row[];
    const shape = def.shape(rows);
    return { id: def.id, name: def.name, definition: def.definition, grain: def.grain, scope: def.scope, unit: def.unit ?? 'count', sql, params, ...shape };
  });
  return { title: 'GTM data-quality scorecard', generatedAt: new Date(nowMs).toISOString(), sinceDays, windowStart, controls };
}

// ---- rendering shared by the CLI -------------------------------------------
export function formatValue(c: Pick<Control, 'value' | 'numerator' | 'denominator' | 'unit'>): string {
  if (c.value == null) return 'none';
  const v = c.unit === 'ms' ? `${Math.round(c.value)} ms` : c.unit === 'hours' ? `${c.value} h` : String(c.value);
  return c.denominator != null && c.numerator != null && c.unit === 'count' ? `${v} of ${c.denominator}` : v;
}

export function toMarkdown(sc: Scorecard): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# ${sc.title}`, '',
    `Generated ${sc.generatedAt}. ${sc.sinceDays == null ? 'All stored history.' : `Window: ${sc.sinceDays} day(s) back from the newest stored event (from ${sc.windowStart ?? 'n/a'}).`} Every value is computed from stored rows; the query for each control is in out/quality-scorecard.json.`,
    '', '| Control | Value | Definition |', '|---|---|---|',
  ];
  for (const c of sc.controls) {
    const extra = c.breakdown?.length ? ` (${c.breakdown.map(b => `${b.label}: ${b.value == null ? 'none' : b.value}`).join('; ')})` : '';
    lines.push(`| ${cell(c.name)} | ${cell(formatValue(c) + extra)} | ${cell(c.definition)} |`);
  }
  return lines.join('\n') + '\n';
}
