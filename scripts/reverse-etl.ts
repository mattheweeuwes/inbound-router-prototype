// npm run reverse-etl: builds the HubSpot company batch upsert from the v_account_scores view.
// Dry-run: the request bodies go to out/hubspot/reverse-etl-<date>.jsonl and are printed as a summary. Nothing is sent.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCtx } from '../src/context';
import { PATHS } from '../src/crm/hubspot';
import { executeCrm } from '../src/crm/hubspot';

const ctx = createCtx();
type AccountScoreRow = { account_key: string; name: string | null; segment: string | null; account_score: number; leads_30d: number; web_intent_points: number };
const rows = ctx.db.prepare(`SELECT account_key, name, segment, account_score, leads_30d, web_intent_points FROM v_account_scores WHERE leads_30d > 0 OR web_intent_points > 0 ORDER BY account_score DESC, account_key`).all() as AccountScoreRow[];
const BATCH = 100; // HubSpot batch limit
const requests = [];
for (let i = 0; i < rows.length; i += BATCH) {
  requests.push({
    method: 'POST' as const, path: PATHS.companiesUpsert,
    body: { inputs: rows.slice(i, i + BATCH).map(r => ({
      id: r.account_key, idProperty: 'serif_account_key',
      properties: { name: r.name, serif_account_key: r.account_key, serif_segment: r.segment, serif_account_score: r.account_score, serif_open_leads: r.leads_30d, serif_web_intent_points: r.web_intent_points },
    })) },
  });
}
const out = await executeCrm(ctx, requests);
const at = new Date().toISOString();
if (out.mode === 'dry_run') {
  const dir = join(ctx.cfg.outDir, 'hubspot');
  mkdirSync(dir, { recursive: true });
  for (const r of requests) appendFileSync(join(dir, `reverse-etl-${at.slice(0, 10)}.jsonl`), JSON.stringify({ at, ...r }) + '\n');
}
console.log(`reverse ETL (${out.mode}): ${rows.length} account(s) in ${requests.length} batch request(s)`);
for (const r of rows.slice(0, 8)) console.log(`  ${String(r.account_key).padEnd(28)} score ${String(r.account_score).padStart(3)}  leads ${r.leads_30d}  intent ${r.web_intent_points}  ${r.name}`);
