// SQL for the outbound module: the rate file's rows, the patterns, the findings and their registry links. The loader
// (src/outbound/load.ts) writes them in one transaction; the API and the router's rate line read them. The one-rate rule
// and the city tops are views in sql/models. A person's link decisions (rate_link_decisions) are written one at a time by
// the API and are never cleared by a reload, and the newest inbound lead at an account is read here for suppression.
import type { StatementSync } from 'node:sqlite';
import { allRows, getRow, json, parse, type Db } from '../db';
import type { Hook } from '../outbound/draft';
import type { Band, Finding, GroupRow, Pattern, Patterns } from '../outbound/findings';
import type { RecentLead } from '../outbound/holds';
import type { Decision, LinkDecision } from '../outbound/linkReview';
import type { ContractForm, Hit } from '../outbound/patterns';
import type { RateFileScope, RateRow } from '../outbound/rateFile';
import type { Targeting } from '../outbound/targeting';
import type { NameLink } from '../resolve';
import type { Candidate } from '../schema';

/** A group as stored: its finding, its fit and draft status, and its hook. */
export type OutboundGroup = Finding & Targeting & { hook: Hook };

export type RateFileRow = {
  path: string; sha256: string; inputs_sha256: string; rows: number; payer: string | null; network: string | null;
  network_month: string | null; code: string | null; loaded_at: string;
};

export interface RateFileMeta { path: string; sha256: string; inputsSha256: string; rows: number; scope: RateFileScope; loadedAt: string }

/** A rate row as the API shows it under its group. */
export type SourceRow = {
  id: number; entity: string; city: string | null; state: string | null; taxonomy: string | null; npis: number; src_npis: number;
  org_npis: number; rate: number; medicare: number; pct_medicare: number; most_npis: number; claims_evidence: number; pos: string | null; chosen: number;
};

type FindingRow = {
  ein: string; account_key: string; name: string; name_norm: string; city: string | null; state: string | null; clinicians: number; band: Band;
  rate: number; medicare: number; pct_medicare: number; form: ContractForm; card_tier: number | null; factor_multiple: number | null;
  city_top_rate: number; city_top_clinicians: number; city_top_ein: string; band_median_pct: number; fit: Targeting['fit']; fit_reason: string;
  platform: string | null; platform_confirmed: number | null; draft_status: Targeting['draftStatus']; draft_reason: string | null; hook: Hook;
};
type LinkRow = { status: NameLink['status']; account_id: string | null; account_name: string | null; method: 'company_name'; score: number | null; reason: string; candidates_json: string };
type PatternRow = { kind: Pattern['kind']; value: number; hits: number; distinct_rates: number; runners_up_json: string | null };
export type BandFormRow = { band: Band; form: ContractForm; groups: number };
type DecisionRow = { ein: string; decision: Decision; account_id: string | null; account_name: string | null; decided_by: string; note: string | null; decided_at: string };
type RecentLeadRow = { id: string; owner: string | null; route_team: string | null; received_at: string; name: string | null };

const FINDING_COLS: (keyof FindingRow)[] = [
  'ein', 'account_key', 'name', 'name_norm', 'city', 'state', 'clinicians', 'band', 'rate', 'medicare', 'pct_medicare', 'form', 'card_tier',
  'factor_multiple', 'city_top_rate', 'city_top_clinicians', 'city_top_ein', 'band_median_pct', 'fit', 'fit_reason', 'platform',
  'platform_confirmed', 'draft_status', 'draft_reason', 'hook',
];

const toGroup = (r: FindingRow): OutboundGroup => ({
  ein: r.ein, accountKey: r.account_key, name: r.name, nameNorm: r.name_norm, city: r.city ?? '', state: r.state, clinicians: r.clinicians,
  band: r.band, rate: r.rate, medicare: r.medicare, pctOfMedicare: r.pct_medicare, form: r.form, cardTier: r.card_tier,
  factorMultiple: r.factor_multiple, cityTopRate: r.city_top_rate, cityTopClinicians: r.city_top_clinicians, cityTopEin: r.city_top_ein,
  bandMedianPct: r.band_median_pct, fit: r.fit, fitReason: r.fit_reason, platform: r.platform,
  platformConfirmed: r.platform_confirmed === null ? null : !!r.platform_confirmed, draftStatus: r.draft_status, draftReason: r.draft_reason, hook: r.hook,
});

const toRow = (g: OutboundGroup): FindingRow => ({
  ein: g.ein, account_key: g.accountKey, name: g.name, name_norm: g.nameNorm, city: g.city, state: g.state, clinicians: g.clinicians,
  band: g.band, rate: g.rate, medicare: g.medicare, pct_medicare: g.pctOfMedicare, form: g.form, card_tier: g.cardTier,
  factor_multiple: g.factorMultiple, city_top_rate: g.cityTopRate, city_top_clinicians: g.cityTopClinicians, city_top_ein: g.cityTopEin,
  band_median_pct: g.bandMedianPct, fit: g.fit, fit_reason: g.fitReason, platform: g.platform,
  platform_confirmed: g.platformConfirmed === null ? null : g.platformConfirmed ? 1 : 0, draft_status: g.draftStatus, draft_reason: g.draftReason, hook: g.hook,
});

const toDecision = (r: DecisionRow): LinkDecision => ({
  ein: r.ein, decision: r.decision, accountId: r.account_id, accountName: r.account_name, decidedBy: r.decided_by, note: r.note, decidedAt: r.decided_at,
});

const toPattern = (r: PatternRow): Pattern => ({ kind: r.kind, value: r.value, hits: r.hits, distinctRates: r.distinct_rates, runnersUp: parse<Hit[]>(r.runners_up_json) ?? [] });

export function outboundStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    file: p(`SELECT path, sha256, inputs_sha256, rows, payer, network, network_month, code, loaded_at FROM rate_file WHERE id = 1`),
    clear: ['rate_links', 'rate_findings', 'rate_patterns', 'rate_rows', 'rate_file'].map(t => p(`DELETE FROM ${t}`)),
    insertRow: p(`INSERT INTO rate_rows (ein, entity, name_norm, state, city, taxonomy, npis, src_npis, org_npis, rate, medicare, pct_medicare,
      most_npis, claims_evidence, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertFile: p(`INSERT INTO rate_file (id, path, sha256, inputs_sha256, rows, payer, network, network_month, code, loaded_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    distinctRates: p(`SELECT DISTINCT rate FROM rate_rows ORDER BY rate`),
    groups: p(`SELECT g.ein, g.entity, g.name_norm, g.state, g.city, g.org_npis, g.rate, g.medicare, g.pct_medicare, g.band,
      t.top_rate, t.top_clinicians, t.top_ein
      FROM v_rate_groups g JOIN v_rate_groups_city_top t ON t.city IS g.city AND t.state IS g.state ORDER BY g.ein`),
    insertPattern: p(`INSERT INTO rate_patterns (kind, value, hits, distinct_rates, runners_up_json) VALUES (?, ?, ?, ?, ?)`),
    patterns: p(`SELECT kind, value, hits, distinct_rates, runners_up_json FROM rate_patterns`),
    insertGroup: p(`INSERT INTO rate_findings (${FINDING_COLS.join(', ')}) VALUES (${FINDING_COLS.map(() => '?').join(', ')})`),
    insertLink: p(`INSERT INTO rate_links (ein, status, account_id, account_name, method, score, reason, candidates_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    allGroups: p(`SELECT * FROM rate_findings ORDER BY state, city, rate`),
    group: p(`SELECT * FROM rate_findings WHERE ein = ?`),
    link: p(`SELECT status, account_id, account_name, method, score, reason, candidates_json FROM rate_links WHERE ein = ?`),
    links: p(`SELECT ein, account_id FROM rate_links WHERE status = 'linked'`),
    sourceRows: p(`SELECT r.id, r.entity, r.city, r.state, r.taxonomy, r.npis, r.src_npis, r.org_npis, r.rate, r.medicare, r.pct_medicare,
      r.most_npis, r.claims_evidence, r.pos, (r.id = g.id) AS chosen
      FROM rate_rows r JOIN v_rate_groups g ON g.ein = r.ein WHERE r.ein = ? ORDER BY r.id`),
    bandForm: p(`SELECT band, form, COUNT(*) AS groups FROM rate_findings GROUP BY band, form ORDER BY band, form`),
    // an exact link, or a link a person confirmed: the two ways a group is known to belong to an account
    linkedTo: p(`SELECT f.* FROM rate_findings f WHERE f.ein IN (
      SELECT ein FROM rate_links WHERE status = 'linked' AND account_id = ?
      UNION SELECT ein FROM rate_link_decisions WHERE decision = 'confirmed' AND account_id = ?)
      ORDER BY f.clinicians DESC, f.ein`),
    byName: p(`SELECT * FROM rate_findings WHERE name_norm = ? AND state = ? ORDER BY clinicians DESC, ein`),
    decisions: p(`SELECT ein, decision, account_id, account_name, decided_by, note, decided_at FROM rate_link_decisions`),
    decision: p(`SELECT ein, decision, account_id, account_name, decided_by, note, decided_at FROM rate_link_decisions WHERE ein = ?`),
    // one decision per EIN: a later one replaces it
    saveDecision: p(`INSERT INTO rate_link_decisions (ein, decision, account_id, account_name, decided_by, note, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ein) DO UPDATE SET decision = excluded.decision, account_id = excluded.account_id, account_name = excluded.account_name,
        decided_by = excluded.decided_by, note = excluded.note, decided_at = excluded.decided_at`),
    clearDecision: p(`DELETE FROM rate_link_decisions WHERE ein = ?`),
    // the newest person lead at an account since a time (web intent has no person, so it is not a conversation)
    recentLead: p(`SELECT l.id, l.owner, l.route_team, e.received_at, NULLIF(TRIM(COALESCE(l.first_name, '') || ' ' || COALESCE(l.last_name, '')), '') AS name
      FROM leads l JOIN lead_events e ON e.id = l.id
      WHERE l.account_id = ? AND e.received_at >= ? AND e.source != 'web_intent'
      ORDER BY e.received_at DESC, l.id LIMIT 1`),
  };

  return {
    file: (): RateFileMeta | null => {
      const r = getRow<RateFileRow>(s.file);
      return r ? {
        path: r.path, sha256: r.sha256, inputsSha256: r.inputs_sha256, rows: r.rows, loadedAt: r.loaded_at,
        scope: { payer: r.payer ?? '', network: r.network ?? '', networkMonth: r.network_month ?? '', code: r.code ?? '' },
      } : null;
    },
    /** Empties every outbound table. The loader calls it inside its transaction. */
    clear: () => { for (const st of s.clear) st.run(); },
    insertRows: (rows: RateRow[]) => {
      for (const r of rows) {
        s.insertRow.run(r.ein, r.entity, r.nameNorm, r.state, r.city, r.taxonomy, r.npis, r.srcNpis, r.orgNpis, r.rate, r.medicare, r.pctMedicare,
          r.mostNpis ? 1 : 0, r.claimsEvidence ? 1 : 0, r.pos);
      }
    },
    saveFile: (m: RateFileMeta) => {
      s.insertFile.run(m.path, m.sha256, m.inputsSha256, m.rows, m.scope.payer, m.scope.network, m.scope.networkMonth, m.scope.code, m.loadedAt);
    },
    distinctRates: (): number[] => allRows<{ rate: number }>(s.distinctRates).map(r => r.rate),
    /** One row per group with its city's top: the input to buildFindings. */
    groups: (): GroupRow[] => allRows<GroupRow>(s.groups),
    savePatterns: (ps: Patterns) => {
      for (const pt of [ps.card, ps.factor]) if (pt) s.insertPattern.run(pt.kind, pt.value, pt.hits, pt.distinctRates, json(pt.runnersUp));
    },
    patterns: (): Patterns => {
      const rows = allRows<PatternRow>(s.patterns).map(toPattern);
      return { card: rows.find(r => r.kind === 'card') ?? null, factor: rows.find(r => r.kind === 'factor') ?? null };
    },
    saveGroup: (g: OutboundGroup) => { const row = toRow(g); s.insertGroup.run(...FINDING_COLS.map(c => row[c])); },
    saveLink: (ein: string, l: NameLink) => {
      s.insertLink.run(ein, l.status, l.accountId, l.accountName, l.method, l.score, l.reason, json(l.candidates));
    },
    allGroups: (): OutboundGroup[] => allRows<FindingRow>(s.allGroups).map(toGroup),
    group: (ein: string): OutboundGroup | null => { const r = getRow<FindingRow>(s.group, ein); return r ? toGroup(r) : null; },
    link: (ein: string): NameLink | null => {
      const r = getRow<LinkRow>(s.link, ein);
      return r ? { status: r.status, accountId: r.account_id, accountName: r.account_name, method: r.method, score: r.score, reason: r.reason, candidates: parse<Candidate[]>(r.candidates_json) ?? [] } : null;
    },
    /** EIN to registry account, for every linked group. */
    linkedAccounts: (): Map<string, string> => new Map(allRows<{ ein: string; account_id: string }>(s.links).map(r => [r.ein, r.account_id])),
    sourceRows: (ein: string): SourceRow[] => allRows<SourceRow>(s.sourceRows, ein),
    bandForm: (): BandFormRow[] => allRows<BandFormRow>(s.bandForm),
    /** Groups that belong to a registry account (an exact link or a confirmed one), largest first. */
    linkedTo: (accountId: string): OutboundGroup[] => allRows<FindingRow>(s.linkedTo, accountId, accountId).map(toGroup),
    /** Groups with this normalized name in this state, largest first. */
    byName: (nameNorm: string, state: string): OutboundGroup[] => allRows<FindingRow>(s.byName, nameNorm, state).map(toGroup),
    /** Every person's link decision, by EIN. They outlive reloads of the rate file. */
    decisions: (): Map<string, LinkDecision> => new Map(allRows<DecisionRow>(s.decisions).map(r => [r.ein, toDecision(r)])),
    decision: (ein: string): LinkDecision | null => { const r = getRow<DecisionRow>(s.decision, ein); return r ? toDecision(r) : null; },
    saveDecision: (d: LinkDecision) => { s.saveDecision.run(d.ein, d.decision, d.accountId, d.accountName, d.decidedBy, d.note, d.decidedAt); },
    /** Removes a person's decision on one EIN, so the group goes back to what the loader found. True when there was one to remove. */
    clearDecision: (ein: string): boolean => Number(s.clearDecision.run(ein).changes) > 0,
    /** The newest person lead at an account received at or after `since`, or null. */
    recentLead: (accountId: string, since: string): RecentLead | null => {
      const r = getRow<RecentLeadRow>(s.recentLead, accountId, since);
      return r ? { id: r.id, owner: r.owner, routeTeam: r.route_team, receivedAt: r.received_at, name: r.name } : null;
    },
  };
}

export type OutboundStore = ReturnType<typeof outboundStore>;
