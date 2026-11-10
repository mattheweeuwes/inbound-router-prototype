// npm run day: one working day at Serif as a scenario (scripts/lib/day.ts, docs/day-in-the-life.md). In process, rules only,
// offline, HubSpot dry-run, on the clock in fixtures/day/morning.json. It replays the 40 base fixtures, the fifteen morning events,
// a seeded 150-scan list upload, then reads the outbound summary, the attribution API, the accounts API and the team brief.
// Prints each event with what was expected, what happened and whether it holds; exits 1 when any assertion fails.
// It runs the list twice, in two fresh databases, to check that the same seed gives the same decisions.
//   --seed <n>    the list's seed (default 20261110)
//   --count <n>   the list's rows (default 150)
// Output goes to out/day/ (report.txt, report.json, brief.txt). The database is in memory.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig, ROOT } from '../src/config';
import { createCtx, type Ctx } from '../src/context';
import { briefText } from '../src/todayBrief';
import { NO_OUTSIDE_WRITES } from './lib/outside-writes';
import { checkDay, DAY_DEFAULTS, decisionFingerprint, loadDay, playDay, reportText } from './lib/day';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const seed = Number(flag('seed') ?? DAY_DEFAULTS.seed);
const listCount = Number(flag('count') ?? DAY_DEFAULTS.listCount);
if (!Number.isInteger(seed) || !Number.isInteger(listCount) || listCount < 1) { console.error('--seed and --count take whole numbers'); process.exit(1); }

const day = loadDay();
const outDir = join(ROOT, 'out', 'day');
const realRates = makeConfig().ratesCsv;

/** A fresh context on the day's clock: nothing leaves the machine, whatever the environment says. */
const freshCtx = (): Ctx => createCtx({
  ...NO_OUTSIDE_WRITES, appDb: ':memory:', outDir, now: () => Date.parse(day.clock),
  llmProvider: 'rules', network: false, anthropicKey: null, demoRoutes: false,
  calendlyKey: 'local-demo-signing-key-not-a-secret',
  // the real rate file when it has been fetched, the invented one otherwise
  ...(existsSync(realRates) ? {} : { ratesCsv: join(ROOT, 'test', 'fixtures', 'rates-mini.csv'), outboundPlatforms: join(ROOT, 'test', 'fixtures', 'outbound-platforms-mini.json') }),
  // commits in acceptance order and the list's digests flushed by the scenario, so a run is the same every time
  commitGraceMs: null, listDoors: ['event_scan'], listDoorModel: 'after_alert', listQuietMs: 3_600_000,
});

const opt = { ...DAY_DEFAULTS, seed, listCount };
const ctx = freshCtx();
console.log(`registry=${ctx.registry.kind} rates=${ctx.outbound.status} usage=${ctx.usage.status} llm=${ctx.cfg.llmProvider} hubspot=dry-run clock=${day.clock}`);
const played = await playDay(ctx, opt, day);
const again = await playDay(freshCtx(), opt, day);
const report = checkDay(played, day, decisionFingerprint(again.list.leads));

const text = reportText(played, report);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.txt'), text);
writeFileSync(join(outDir, 'report.json'), JSON.stringify({ clock: played.clock, registry: ctx.registry.kind, report }, null, 2));
writeFileSync(join(outDir, 'brief.txt'), briefText(played.brief));
process.stdout.write(text);
process.exit(report.failed ? 1 : 0);
