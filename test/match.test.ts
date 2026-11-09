import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ROOT } from '../src/config';
import { matchCompany, nameNorm, scoreNames } from '../src/resolve/match';
import { resolve } from '../src/resolve';
import { adapt } from '../src/sources';
import { buildPayload } from '../src/payloads';
import { normalizeEvent } from '../src/normalize';
import { registryLookups } from '../src/resolve/domain';
import { spec, testCtx } from './helpers';
import { verifiedDetail } from '../src/resolve';

describe('name_norm parity with the ETL rule', () => {
  // the same cases etl/name_norm.py asserts, plus hyphens and accents
  const cases: [string, string][] = [
    ['Baptist Health South Florida, Inc.', 'baptist health south florida'],
    ['Johns Hopkins Health System Corporation', 'johns hopkins health system'],
    ['The Johns Hopkins Hospital', 'johns hopkins hospital'],
    ["St. Luke's Health System, Ltd.", 'st lukes health system'],
    ["Brigham & Women's Hospital", 'brigham and womens hospital'],
    ['OhioHealth', 'ohiohealth'],
    ['Blue Cross & Blue Shield of Michigan', 'blue cross and blue shield michigan'],
    ['Cressey & Company', 'cressey and'],
    ['AMG   Integrated-Healthcare Management', 'amg integrated healthcare management'],
    ['H\u00f4pital Sainte-Anne Co.', 'hopital sainte anne'],
    ['Northside Hospital - Gwinnett', 'northside hospital gwinnett'],
    ['Dartmouth-Hitchcock', 'dartmouth hitchcock'],
    ['', ''],
    ['Inc. LLC The', ''],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> "${expected}"`, () => assert.equal(nameNorm(input), expected));
  }
  it('keeps health, hospital, system, medical, center', () => assert.equal(nameNorm('Valley Medical Center Health System'), 'valley medical center health system'));
  it('agrees with the real registry name_norm column when it exists', { skip: !existsSync(join(ROOT, 'data', 'registry.sqlite')) }, () => {
    const db = new DatabaseSync(join(ROOT, 'data', 'registry.sqlite'), { readOnly: true });
    const rows = db.prepare(`SELECT name, name_norm FROM (SELECT name, name_norm FROM ahrq_systems UNION ALL SELECT name, name_norm FROM cms_hospitals UNION ALL SELECT name, name_norm FROM payers)`).all() as any[];
    db.close();
    const bad = rows.filter(r => nameNorm(r.name) !== r.name_norm);
    assert.equal(bad.length, 0, `${bad.length} of ${rows.length} differ, e.g. ${JSON.stringify(bad.slice(0, 3))}`);
  });
});

describe('scoring and thresholds', () => {
  it('generic tokens carry less weight than identity tokens', () => {
    assert.ok(scoreNames('valley health', 'ridge health') < scoreNames('valley health', 'valley medical'));
  });
  const ctx = testCtx();
  it('a unique strong match resolves (OhioHealth, OH)', () => {
    const m = matchCompany(ctx.db, 'OhioHealth', 'OH');
    assert.equal(m.outcome, 'unique');
    assert.equal(m.top?.accountId, 'ahrq:SYS-OHIOHLTH');
  });
  it('a hospital name resolves to its parent system, and sibling hospitals do not make it ambiguous', () => {
    const m = matchCompany(ctx.db, 'Northside Hospital', 'GA');
    assert.equal(m.outcome, 'unique');
    assert.equal(m.top?.accountId, 'ahrq:SYS-NORTHSIDE');
  });
  it('several near-equal candidates are ambiguous and carry up to five candidates', () => {
    const m = matchCompany(ctx.db, 'Baptist Health', null);
    assert.equal(m.outcome, 'ambiguous');
    assert.ok(m.candidates.length >= 2 && m.candidates.length <= 5);
  });
  it('review candidates are only those scoring 0.75+ or within 0.15 of the top', () => {
    const m = matchCompany(ctx.db, 'Baptist Health', null);
    const top = m.candidates[0].score;
    for (const c of m.candidates) assert.ok(c.score >= 0.75 || top - c.score <= 0.15 + 1e-9, `${c.name} ${c.score}`);
  });
  it('a state narrows the same name to one account', () => {
    assert.equal(matchCompany(ctx.db, 'Baptist Health', 'KY').outcome, 'unique');
  });
  it('a weak match is not a match', () => {
    assert.equal(matchCompany(ctx.db, 'Zzzz Holdings', null).outcome, 'none');
  });
});

describe('domain beats TLD heuristics', () => {
  const ctx = testCtx();
  const run = async (email: string, company: string) => {
    const ev = adapt('calendly_demo', buildPayload('calendly_demo', spec({ email, company })));
    return resolve(ctx, ev, normalizeEvent(ev, registryLookups(ctx.db)));
  };
  it('jhmi.edu is a health system, not academic', async () => {
    const r = await run('mtanaka@jhmi.edu', 'Johns Hopkins Medicine');
    assert.equal(r.segment, 'health_system');
    assert.equal(r.method, 'org_domain');
    assert.equal(r.accountId, 'ahrq:SYS-JHHS');
  });
  it('an unknown .edu falls through to academic', async () => {
    const r = await run('epark@gatech.edu', 'Georgia Tech');
    assert.equal(r.segment, 'academic');
    assert.equal(r.method, 'tld');
  });
  it('a hospital domain resolves to the parent system when AHRQ links one', async () => {
    const r = await run('x@jeffersonhealthcare.org', 'Jefferson Healthcare');
    assert.equal(r.segment, 'standalone_hospital');
    assert.equal(r.accountId, 'ccn:500005');
  });
  it('free-mail with a company name resolves at medium confidence', async () => {
    const r = await run('mreyes@outlook.com', 'Northside Hospital');
    assert.equal(r.status, 'resolved');
    assert.equal(r.confidence, 'medium');
    assert.equal(r.method, 'company_name');
  });
  it('free-mail with an ambiguous company is ambiguous, not guessed', async () => {
    const r = await run('lprice@gmail.com', 'Baptist Health');
    assert.equal(r.status, 'ambiguous');
    assert.ok(r.candidates.length >= 2);
  });
  it('network off: an unknown corporate domain degrades to unresolved with the reason noted', async () => {
    const r = await run('bmendez@mohawkind.com', 'Mohawk Industries');
    assert.equal(r.status, 'unresolved');
    assert.ok(r.evidence.some(e => e.step === 'company_name'));
  });
});

describe('resolution evidence is split into plain steps', () => {
  it('turns the ETL evidence string into a sentence, decoding entities, without HTML escaping', () => {
    assert.equal(verifiedDetail("seed | title='Home - Intermountain Health' | GET https://intermountainhealthcare.org/ -> https://www.intermountainhealth.org/"),
      'homepage title "Home - Intermountain Health" (redirects to intermountainhealth.org)');
    assert.equal(verifiedDetail("seed | title='Cressey &amp; Company' | GET https://a.org/ -> https://www.a.org/"), 'homepage title "Cressey & Company"');
    assert.match(verifiedDetail("seed | BODY-TEXT MATCH (title generic): title='Universal WordPress Theme Support' | GET https://jhmi.edu/ -> https://jhmi.edu/ | page text: 'x'") ?? '', /homepage title .*the homepage text names the organization/);
    assert.equal(verifiedDetail(null), null);
  });
  it('a known domain yields an org_domain step and a separate verified step', async () => {
    const ctx = testCtx();
    const ev = adapt('calendly_demo', buildPayload('calendly_demo', spec({ email: 'x@intermountainhealthcare.org' })));
    const r = await resolve(ctx, ev, normalizeEvent(ev, registryLookups(ctx.db)));
    assert.deepEqual(r.evidence.map(e => e.step), ['org_domain', 'verified']);
    assert.equal(r.evidence[0].detail, 'intermountainhealthcare.org maps to AHRQ health system SYS-INTERMTN, Intermountain Health');
  });
});
