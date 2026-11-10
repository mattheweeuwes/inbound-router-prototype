// npm run reverse-etl: builds the HubSpot company batch upsert from the v_account_scores view and from product usage.
// Each company carries its lead scores and, when the account has used the product, the features used in the last 30 days, its
// latest feature use and its 30-day event count per feature (src/usage/rollup.ts).
// Dry-run: the request bodies go to out/hubspot/reverse-etl-<date>.jsonl and are printed as a summary. Nothing is sent.
// The expansion tasks for customer success (src/usage/expansion.ts) are written beside them as a dry run only, whatever the mode.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCtx } from '../src/context';
import { executeCrm, PATHS, usageCompanyProperties } from '../src/crm/hubspot';
import { describeAccount } from '../src/usage/account';
import { expansionSignals } from '../src/usage/expansion';
import { usageRollups } from '../src/usage/rollup';

const ctx = createCtx();
type AccountScoreRow = { account_key: string; name: string | null; segment: string | null; account_score: number; leads_30d: number; web_intent_points: number };
const scores = ctx.db.prepare(`SELECT account_key, name, segment, account_score, leads_30d, web_intent_points FROM v_account_scores WHERE leads_30d > 0 OR web_intent_points > 0 ORDER BY account_score DESC, account_key`).all() as AccountScoreRow[];
const usage = usageRollups(ctx.store.usage.byAccountFeature());

/** One company: the lead scores when the account has leads, the usage rollup when it has product use. An account with both is one row. */
interface CompanyRow { account_key: string; name: string | null; segment: string | null; scored: AccountScoreRow | null }
const companies = new Map<string, CompanyRow>(scores.map(r => [r.account_key, { account_key: r.account_key, name: r.name, segment: r.segment, scored: r }]));
for (const key of usage.keys()) {
  if (companies.has(key)) continue;
  const a = describeAccount(ctx, key);
  companies.set(key, { account_key: key, name: a.name, segment: a.segment, scored: null });
}
const rows = [...companies.values()];

const BATCH = 100; // HubSpot batch limit
const requests = [];
for (let i = 0; i < rows.length; i += BATCH) {
  requests.push({
    method: 'POST' as const, path: PATHS.companiesUpsert,
    body: { inputs: rows.slice(i, i + BATCH).map(r => {
      const u = usage.get(r.account_key);
      return {
        id: r.account_key, idProperty: 'serif_account_key',
        properties: {
          name: r.name, serif_account_key: r.account_key, serif_segment: r.segment,
          ...(r.scored ? { serif_account_score: r.scored.account_score, serif_open_leads: r.scored.leads_30d, serif_web_intent_points: r.scored.web_intent_points } : {}),
          ...(u ? usageCompanyProperties(u) : {}),
        },
      };
    }) },
  });
}
const out = await executeCrm(ctx, requests);
const at = new Date().toISOString();
const dir = join(ctx.cfg.outDir, 'hubspot');
if (out.mode === 'dry_run') {
  mkdirSync(dir, { recursive: true });
  for (const r of requests) appendFileSync(join(dir, `reverse-etl-${at.slice(0, 10)}.jsonl`), JSON.stringify({ at, ...r }) + '\n');
}

// expansion tasks: built and written, never executed, so they are a dry run even when the company batch above went live
const signals = expansionSignals(ctx, ctx.store.usage.asOf());
if (signals.length) {
  mkdirSync(dir, { recursive: true });
  for (const s of signals) for (const r of s.hubspot.requests) appendFileSync(join(dir, `expansion-tasks-${at.slice(0, 10)}.jsonl`), JSON.stringify({ at, account: s.account.key, ...r }) + '\n');
}

console.log(`reverse ETL (${out.mode}): ${rows.length} account(s) in ${requests.length} batch request(s), ${usage.size} with product usage`);
for (const r of rows.slice(0, 8)) {
  const u = usage.get(r.account_key);
  const lead = r.scored ? `score ${String(r.scored.account_score).padStart(3)}  leads ${r.scored.leads_30d}  intent ${r.scored.web_intent_points}` : 'no leads';
  console.log(`  ${String(r.account_key).padEnd(28)} ${lead}${u ? `  features 30d: ${u.features30d.join(';') || 'none'}` : ''}  ${r.name}`);
}
console.log(`expansion tasks (dry run, never sent): ${signals.length}${signals.length ? ` for ${signals.map(s => s.account.name).join(', ')}` : ''}`);
