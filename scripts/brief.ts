// npm run brief: the team brief (src/todayBrief.ts) as plain text, on the database this checkout would serve. Prints it and
// writes it under the output folder as brief.txt and brief.json. Read-only: it opens the database and sends nothing.
//   --hours <n>   how far back the lead-driven sections look (default 24)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCtx } from '../src/context';
import { briefText, buildBrief, windowHours } from '../src/todayBrief';
import { NO_OUTSIDE_WRITES } from './lib/outside-writes';

const args = process.argv.slice(2);
const at = args.indexOf('--hours');
const ctx = createCtx({ ...NO_OUTSIDE_WRITES });
const brief = buildBrief(ctx, windowHours(at >= 0 ? args[at + 1] : null));
const text = briefText(brief);
mkdirSync(ctx.cfg.outDir, { recursive: true });
writeFileSync(join(ctx.cfg.outDir, 'brief.txt'), text);
writeFileSync(join(ctx.cfg.outDir, 'brief.json'), JSON.stringify(brief, null, 2));
process.stdout.write(text);
console.log(`written to ${join(ctx.cfg.outDir, 'brief.txt')} and brief.json`);
process.exit(0);
