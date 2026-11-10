// npm run list:upload: a generated conference badge-scan list (scripts/lib/list-upload.ts), posted at once to a running
// server's event_scan door, as a booth export uploaded in one go would arrive.
//   --count <n>     scans in the list (default 150)
//   --list <name>   the list's name, which every scan carries as its event (default HLTH)
//   --base <url>    the server to post to (default http://127.0.0.1:3480)
//   --seed <n>      the generator's seed (default 20261110); the same seed and --now give the same list
//   --now <iso>     the clock scan times count back from (default now)
//   --out <file>    also write the lead ids, status codes and posting time as JSON
//   --print         print the list as JSON and post nothing
// Organizations come from the registry this checkout would run on (the real one when built, the test one otherwise), so
// point it at a server using the same. Every person is invented and flagged synthetic.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '../src/config';
import { chooseRegistry } from '../src/db';
import type { CrmMirrorEntry } from '../src/schema';
import { generateList, mirrorCustomers, postList, registryOrgs, type BadgeScan } from './lib/list-upload';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const count = Number(flag('count') ?? 150);
const seed = Number(flag('seed') ?? 20261110);
const now = flag('now') ? Date.parse(flag('now')!) : Date.now();
const listName = flag('list') ?? 'HLTH';
const base = (flag('base') ?? 'http://127.0.0.1:3480').replace(/\/$/, '');
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(seed) || Number.isNaN(now)) {
  console.error('--count and --seed take whole numbers, --now an ISO time');
  process.exit(1);
}

const cfg = makeConfig();
const registry = chooseRegistry(cfg);
const reg = new DatabaseSync(registry.path, { readOnly: true });
const orgs = registryOrgs(reg, '');
reg.close();
const mirror = JSON.parse(readFileSync(join(cfg.fixturesDir, 'crm-mirror.json'), 'utf8')) as CrmMirrorEntry[];
const list = generateList(orgs, mirrorCustomers(mirror), { count, listName, seed, now });

if (args.includes('--print')) {
  console.log(JSON.stringify(list.scans, null, 2));
  process.exit(0);
}

const post = async (payload: BadgeScan) => {
  const res = await fetch(`${base}/api/inbound?source=event_scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = (await res.json().catch(() => ({}))) as { leadId?: string };
  return { status: res.status, leadId: body.leadId ?? null };
};
const t0 = performance.now();
const r = await postList(list.scans, post);
const seconds = Math.round(performance.now() - t0) / 1000;
console.log(`registry=${registry.kind}: posted ${list.scans.length} scans of ${listName} to ${base} in ${seconds} s; status codes ${JSON.stringify(r.codes)}; distinct leads ${new Set(r.ids.filter(Boolean)).size}`);
const out = flag('out');
if (out) writeFileSync(out, JSON.stringify({ listName, seed, posted: list.scans.length, codes: r.codes, postSeconds: seconds, startedAt: new Date(Date.now() - seconds * 1000).toISOString(), ids: r.ids, kinds: list.kinds }, null, 2));
