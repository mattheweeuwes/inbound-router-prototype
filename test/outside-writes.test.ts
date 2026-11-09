import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config';
import { createCtx } from '../src/context';
import { inCi, MAY_WRITE_CRM, NO_OUTSIDE_WRITES, refuseLiveCrmInCi } from '../scripts/lib/outside-writes';

describe('CI never writes to a live CRM', () => {
  it('refuses when CI is set and HubSpot is live', () => {
    for (const ci of ['true', '1', 'TRUE', 'yes']) assert.match(refuseLiveCrmInCi({ CI: ci }, true) ?? '', /HUBSPOT_LIVE=0/, `CI=${ci}`);
  });
  it('lets a dry-run CI replay through, and a live run outside CI', () => {
    assert.equal(refuseLiveCrmInCi({ CI: 'true' }, false), null);
    for (const ci of [undefined, '', '0', 'false', 'False']) assert.equal(refuseLiveCrmInCi({ CI: ci }, true), null, `CI=${ci}`);
  });
  it('reads CI the way GitHub Actions sets it', () => {
    assert.equal(inCi({ CI: 'true' }), true);
    assert.equal(inCi({}), false);
  });
});

describe('scripts that must not write outside this machine', () => {
  const saved = { live: process.env.HUBSPOT_LIVE, key: process.env.HUBSPOT_SERVICE_KEY };
  after(() => {
    for (const [k, v] of [['HUBSPOT_LIVE', saved.live], ['HUBSPOT_SERVICE_KEY', saved.key]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('NO_OUTSIDE_WRITES beats a live HubSpot key in the environment', () => {
    process.env.HUBSPOT_LIVE = '1'; process.env.HUBSPOT_SERVICE_KEY = 'not-a-real-key';
    const ctx = createCtx({ appDb: ':memory:', ...NO_OUTSIDE_WRITES });
    assert.equal(ctx.cfg.hubspotLive, false);
    assert.equal(ctx.cfg.hubspotToken, null);
    ctx.db.close();
  });

  it('control: without it, the same environment would be live', () => {
    process.env.HUBSPOT_LIVE = '1'; process.env.HUBSPOT_SERVICE_KEY = 'not-a-real-key';
    const ctx = createCtx({ appDb: ':memory:' });
    assert.equal(ctx.cfg.hubspotLive, true);
    ctx.db.close();
  });

  // Walking tripwire: every script that builds a context either spreads NO_OUTSIDE_WRITES or is on the short list allowed to write to a CRM.
  it('every script that calls createCtx is isolated or on the CRM list', () => {
    const dir = join(ROOT, 'scripts');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter(x => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      const calls = src.match(/createCtx\([^)]*\)/g) ?? [];
      for (const c of calls) if (!(MAY_WRITE_CRM as readonly string[]).includes(f) && !c.includes('NO_OUTSIDE_WRITES')) offenders.push(`${f}: ${c}`);
    }
    assert.deepEqual(offenders, [], 'these scripts inherit .env and could write to a live CRM; spread NO_OUTSIDE_WRITES or add them to MAY_WRITE_CRM on purpose');
  });
});
