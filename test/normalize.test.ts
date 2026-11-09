import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHostname, deriveChannel, normalizeEmail, normalizeEvent, normalizeUtm, titleCase, titleFunction, titleSeniority } from '../src/normalize';
import { registryLookups } from '../src/resolve/domain';
import { adapt } from '../src/sources';
import { buildPayload } from '../src/payloads';
import { spec, testCtx } from './helpers';

describe('UTM normalization', () => {
  it('trims, lowercases and applies the alias map, recording each fix', () => {
    const { utm, fixes } = normalizeUtm({ source: 'LinkedIn ', medium: 'Paid-Social', campaign: 'HS-Contracting-Q4' });
    assert.deepEqual(utm, { source: 'linkedin', medium: 'paid_social', campaign: 'hs-contracting-q4' });
    assert.deepEqual(fixes.map(f => f.field), ['utm_source', 'utm_medium', 'utm_campaign']);
  });
  it('maps every alias in the table', () => {
    for (const [from, to] of [['li', 'linkedin'], ['lnkd', 'linkedin'], ['linkedin.com', 'linkedin'], ['gads', 'google'], ['adwords', 'google'], ['fb', 'facebook'], ['newsletter', 'email'], ['mailchimp', 'email'], ['hs_email', 'email']]) {
      assert.equal(normalizeUtm({ source: from }).utm.source, to, from);
    }
    for (const [from, to] of [['paidsocial', 'paid_social'], ['paid-social', 'paid_social'], ['paid_social', 'paid_social'], ['ppc', 'cpc']]) {
      assert.equal(normalizeUtm({ medium: from }).utm.medium, to, from);
    }
  });
  it('records nothing when the value was already clean', () => {
    assert.deepEqual(normalizeUtm({ source: 'google', medium: 'cpc', campaign: 'brand' }).fixes, []);
  });
  it('derives the channel', () => {
    assert.equal(deriveChannel('calendly_demo', { source: 'linkedin', medium: 'paid_social' }, null), 'paid_social');
    assert.equal(deriveChannel('calendly_demo', { source: 'google', medium: 'cpc' }, null), 'paid_search');
    assert.equal(deriveChannel('calendly_demo', { source: 'email', medium: 'email' }, null), 'email');
    assert.equal(deriveChannel('marketplace', {}, null), 'partner_marketplace');
    assert.equal(deriveChannel('event_scan', {}, null), 'event');
    assert.equal(deriveChannel('api_key', {}, null), 'product');
    assert.equal(deriveChannel('guide_download', {}, 'https://www.google.com/'), 'organic_search');
    assert.equal(deriveChannel('guide_download', {}, null), 'direct');
  });
});

describe('free-mail and disposable detection', () => {
  const ctx = testCtx();
  const lookups = registryLookups(ctx.db);
  const norm = (email: string, company = 'Acme') => normalizeEvent(adapt('guide_download', buildPayload('guide_download', spec({ email, company }))), lookups);
  it('flags free-mail and keeps no company domain for it', () => {
    const n = norm('someone@gmail.com');
    assert.equal(n.isFreeMail, true);
    assert.equal(n.companyDomain, null);
    assert.equal(n.companyRaw, 'Acme');
  });
  it('flags disposable domains', () => {
    const n = norm('x@mailinator.com');
    assert.equal(n.isDisposable, true);
    assert.equal(n.companyDomain, null);
  });
  it('keeps a corporate domain and lowercases the email', () => {
    const n = norm('  DWhitfield@IntermountainHealthcare.org ');
    assert.equal(n.email, 'dwhitfield@intermountainhealthcare.org');
    assert.equal(n.companyDomain, 'intermountainhealthcare.org');
    assert.equal(n.isFreeMail || n.isDisposable, false);
  });
});

describe('the email domain is a DNS hostname or nothing', () => {
  it('accepts ordinary domains and lowercases them', () => {
    assert.equal(normalizeEmail(' DWhitfield@IntermountainHealthcare.org '), 'dwhitfield@intermountainhealthcare.org');
    for (const d of ['a.co', 'mail.example-health.org', 'xn--bcher-kva.example', 'x1.y2.zz']) assert.equal(cleanHostname(d), d, d);
  });
  it('treats a port, path, query, IP literal or bare name as no domain', () => {
    const bad = ['x@127.0.0.1:8080/y.co', 'x@localhost', 'x@[::1]', 'x@127.0.0.1', 'x@10.0.0.5', 'x@evil.com:8080', 'x@evil.com/path', 'x@evil.com?q=1', 'x@evil.com#frag', 'x@a.co.',
      'x@127.0.0.0x1', 'x@0x7f.1', 'x@2130706433', 'x@-bad.com', 'x@bad-.com', 'x@a..co', 'x@under_score.com', 'x@[2001:db8::1]', 'x@evil.com\\.good.com', 'x@a b.com', 'x@', '@a.co'];
    for (const e of bad) assert.equal(normalizeEmail(e), null, e);
    assert.equal(cleanHostname(`${'a'.repeat(64)}.com`), null, 'a label over 63 characters');
    assert.equal(cleanHostname(`${'a.'.repeat(130)}com`), null, 'a name over 253 characters');
  });
  it('an SSRF-shaped email leaves the lead with no email and no company domain', () => {
    const lookups = { isFreeMail: () => false, isDisposable: () => false };
    for (const email of ['x@127.0.0.1:8080/y.co', 'x@localhost', 'x@[::1]']) {
      const n = normalizeEvent(adapt('guide_download', buildPayload('guide_download', spec({ email }))), lookups);
      assert.equal(n.email, null, email);
      assert.equal(n.emailDomain, null, email);
      assert.equal(n.companyDomain, null, email);
    }
  });
  it('a web-intent domain gets the same check', () => {
    const lookups = { isFreeMail: () => false, isDisposable: () => false };
    const wi = (domain: string) => normalizeEvent(adapt('web_intent', { synthetic: true, domain, visits: [{ path: '/a', at: '2026-11-05T14:00:00Z' }] }), lookups);
    assert.equal(wi('Sutterhealth.org').emailDomain, 'sutterhealth.org');
    assert.equal(wi('169.254.169.254').emailDomain, null);
    assert.equal(wi('localhost').emailDomain, null);
  });
});

describe('titles', () => {
  it('title-cases names', () => { assert.equal(titleCase('  asdf   QWER'), 'Asdf Qwer'); assert.equal(titleCase("o'neil-smith"), "O'Neil-Smith"); });
  it('maps title to function', () => {
    const cases: [string, string][] = [
      ['VP Managed Care Contracting', 'managed_care_contracting'], ['Director of Network Management', 'network_strategy'], ['Director of Total Rewards', 'benefits'],
      ['Senior Analyst, Decision Support', 'revenue_cycle_finance'], ['Chief Financial Officer', 'revenue_cycle_finance'], ['VP Value Creation', 'strategy_bd'],
      ['Head of Data Engineering', 'analytics_data'], ['Software Engineer', 'product_engineering'], ['Health Reporter', 'media'], ['Graduate Student', 'research_academic'],
      ['Director, Data Partnerships', 'strategy_bd'], ['Chief Contracting Officer', 'managed_care_contracting'], ['Gardener', 'other'],
    ];
    for (const [t, f] of cases) assert.equal(titleFunction(t), f, t);
  });
  it('maps title to seniority', () => {
    const cases: [string, string][] = [
      ['VP Managed Care Contracting', 'vp'], ['SVP Benefits Consulting', 'vp'], ['Head of Data Engineering', 'vp'], ['Chief Financial Officer', 'c_level'],
      ['Executive Director, Managed Care', 'director'], ['Principal', 'director'], ['Director of Network Management', 'director'], ['Senior Manager, Provider Reimbursement', 'manager'],
      ['Managed Care Analyst', 'individual'], ['Graduate Student', 'student'], ['', 'unknown'],
    ];
    for (const [t, s] of cases) assert.equal(titleSeniority(t || null), s, t);
  });
});
