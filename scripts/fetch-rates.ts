// npm run rates:fetch: downloads Serif's public rate search export to RATES_CSV (default data/rates/mrf_rate_search_export.csv),
// which the outbound module loads at the next start. The file is public and free; data/rates/ is git-ignored, so it is never
// committed. The download is checked with the same parser the loader uses before it replaces anything already there.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeConfig } from '../src/config';
import { parseRateFile } from '../src/outbound/rateFile';

const SOURCE = 'https://mrf.serifhealth.com/public/mrf_rate_search_export.csv';
const target = makeConfig().ratesCsv;

const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) {
  console.error(`${SOURCE} answered ${res.status}; nothing was written`);
  process.exit(1);
}
const text = await res.text();
let summary: string;
try {
  const { scope, rows } = parseRateFile(text);
  summary = `${rows.length} rate rows, ${new Set(rows.map(r => r.ein)).size} groups: ${scope.payer} ${scope.network} ${scope.code} ${scope.networkMonth}`;
} catch (e) {
  console.error(`the download is not a rate file this module can read (${(e as Error).message}); nothing was written`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(`${target}.part`, text);
renameSync(`${target}.part`, target);
console.log(`wrote ${target}: ${summary}. The next start loads it.`);
