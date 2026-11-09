// npm run quality: prints the GTM data-quality scorecard and writes out/quality-scorecard.json and out/quality-scorecard.md.
// Opens data/app.sqlite READ-ONLY. It never writes to the database (no migrations, no views, no registry attach).
// Optional: --since-days N limits the event-grain and lead-grain controls to the last N days before the newest stored event.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../src/config';
import { computeScorecard, formatValue, toMarkdown } from '../src/quality';

const args = process.argv.slice(2);
const i = args.indexOf('--since-days');
const sinceDays = i >= 0 ? Number(args[i + 1]) : undefined;
if (i >= 0 && !(Number.isFinite(sinceDays) && (sinceDays as number) > 0)) { console.error('--since-days needs a positive number'); process.exit(2); }

const dbPath = join(ROOT, 'data', 'app.sqlite');
if (!existsSync(dbPath)) { console.error(`${dbPath} not found: run \`npm run replay\` or \`npm run dev\` first`); process.exit(1); }
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec('PRAGMA query_only = ON;');
let sc;
try { sc = computeScorecard(db, { sinceDays }); } finally { db.close(); }

const w = Math.max(...sc.controls.map(c => c.name.length));
console.log(`${sc.title}  ${sc.generatedAt}${sc.sinceDays != null ? `  (last ${sc.sinceDays} day(s))` : ''}\n`);
for (const c of sc.controls) {
  const parts = c.breakdown?.length ? `  [${c.breakdown.map(b => `${b.label}: ${b.value ?? 'none'}${b.denominator != null ? `/${b.denominator}` : ''}${b.n != null ? ` (n=${b.n})` : ''}`).join(', ')}]` : '';
  console.log(`${c.name.padEnd(w)}  ${formatValue(c).padStart(10)}${parts}`);
}

const out = join(ROOT, 'out');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'quality-scorecard.json'), JSON.stringify(sc, null, 2) + '\n');
writeFileSync(join(out, 'quality-scorecard.md'), toMarkdown(sc));
console.log('\nwrote out/quality-scorecard.json and out/quality-scorecard.md');
