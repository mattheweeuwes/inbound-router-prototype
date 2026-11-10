import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config';
import { executeCrm, LIFECYCLE, propertyDefinitions } from '../src/crm/hubspot';
import { buildBrief } from '../src/brief';
import { buildSlackPayload } from '../src/notify/slack';
import { adapt } from '../src/sources';
import { normalizeEvent } from '../src/normalize';
import { registryLookups } from '../src/resolve/domain';
import { submit, testCtx } from './helpers';

describe('HubSpot request shape', () => {
  it('builds contact upsert, company upsert, v4 association and task with the documented shapes', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { utm: { source: 'LinkedIn ', medium: 'Paid-Social', campaign: 'hs-contracting-q4' } });
    const [company, contact, assoc, task] = lead.crm.requests;
    assert.deepEqual([company.method, company.path], ['POST', '/crm/v3/objects/companies/batch/upsert']);
    assert.equal(company.body.inputs[0].idProperty, 'serif_account_key', 'companies are keyed on the stable account key, not domain');
    assert.equal(company.body.inputs[0].id, 'ahrq:SYS-INTERMTN');
    assert.deepEqual([contact.method, contact.path], ['POST', '/crm/v3/objects/contacts/batch/upsert']);
    const ci = contact.body.inputs[0];
    assert.equal(ci.idProperty, 'email');
    assert.equal(ci.id, 'dwhitfield@intermountainhealthcare.org');
    const p = ci.properties;
    assert.deepEqual([p.firstname, p.lastname, p.jobtitle, p.state, p.hs_lead_status], ['Dana', 'Whitfield', 'VP Managed Care Contracting', 'UT', 'NEW']);
    assert.equal(p.lifecyclestage, 'salesqualifiedlead');
    assert.deepEqual([p.serif_segment, p.serif_use_case, p.serif_urgency, p.serif_tier, p.serif_route_team, p.serif_source], ['health_system', 'contract_negotiation', 'now', 'A', 'HSP', 'calendly_demo']);
    assert.equal(p.serif_account_key, 'ahrq:SYS-INTERMTN');
    assert.equal(typeof p.serif_fit_score, 'number');
    assert.deepEqual([p.first_touch_utm_source, p.last_touch_utm_medium, p.last_touch_utm_campaign], ['linkedin', 'paid_social', 'hs-contracting-q4']);
    assert.deepEqual([assoc.method, assoc.path], ['PUT', '/crm/v4/objects/contacts/{{contact_id}}/associations/default/companies/{{company_id}}']);
    assert.deepEqual([task.method, task.path], ['POST', '/crm/v3/objects/tasks']);
    const tp = task.body.properties;
    assert.equal(tp.hs_timestamp, lead.route.slaDueAt);
    assert.equal(tp.hubspot_owner_id, '900001');
    assert.equal(tp.hs_task_status, 'NOT_STARTED');
    assert.match(tp.hs_task_subject, /Dana Whitfield/);
    assert.match(tp.hs_task_body, /They wrote: "Our commercial renegotiations start in January/);
    assert.deepEqual(task.body.associations.map((a: any) => a.types[0].associationTypeId), [204, 192]);
  });
  it('maps tier to lifecycle stage', () => assert.deepEqual(LIFECYCLE, { A: 'salesqualifiedlead', B: 'marketingqualifiedlead', C: 'lead', D: 'lead' }));
  it('dry-run is the default: nothing is fetched', async () => {
    const ctx = testCtx({}, async () => { throw new Error('HubSpot must not be called'); });
    assert.deepEqual(await executeCrm(ctx, [{ method: 'POST', path: '/x', body: {} }]), { mode: 'dry_run' });
  });
  it('live mode needs both the token and HUBSPOT_LIVE', async () => {
    const onlyFlag = testCtx({ hubspotLive: false, hubspotToken: 'tok' });
    assert.equal((await executeCrm(onlyFlag, [])).mode, 'dry_run');
  });
  it('live mode substitutes record ids from the upsert responses (mock fetch, no network)', async () => {
    const seen: string[] = [];
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async (url: any, init: any) => {
      seen.push(`${init.method} ${String(url).replace('https://api.hubapi.com', '')}`);
      const id = String(url).includes('companies') ? '22' : '11';
      return new Response(JSON.stringify({ results: [{ id }] }), { status: 200 });
    });
    const out = await executeCrm(ctx, [
      { method: 'POST', path: '/crm/v3/objects/companies/batch/upsert', body: {} }, { method: 'POST', path: '/crm/v3/objects/contacts/batch/upsert', body: {} },
      { method: 'PUT', path: '/crm/v4/objects/contacts/{{contact_id}}/associations/default/companies/{{company_id}}', body: null },
    ]);
    assert.equal(out.mode, 'live');
    assert.equal(seen[2], 'PUT /crm/v4/objects/contacts/11/associations/default/companies/22');
  });
  it('live mode maps a synthetic rep owner to the portal owner and reports the mapping', async () => {
    const sent: any[] = [];
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async (url: any, init: any) => {
      if (String(url).includes('/crm/v3/owners')) return new Response(JSON.stringify({ results: [{ id: '777', archived: false }] }), { status: 200 });
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: '5' }), { status: 201 });
    });
    const out = await executeCrm(ctx, [{ method: 'POST', path: '/crm/v3/objects/tasks', body: { properties: { hs_task_subject: 'x', hubspot_owner_id: 'synthetic-avery' } } }]);
    assert.equal(sent[0].properties.hubspot_owner_id, '777');
    assert.deepEqual(out.ownerMapped, [{ from: 'synthetic-avery', to: '777' }]);
    assert.equal(out.ok, true);
  });
  it('live mode drops an owner it cannot map instead of inventing one', async () => {
    const sent: any[] = [];
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async (url: any, init: any) => {
      if (String(url).includes('/crm/v3/owners')) return new Response('{"message":"forbidden"}', { status: 403 });
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ results: [{ id: '22' }] }), { status: 200 });
    });
    const out = await executeCrm(ctx, [{ method: 'POST', path: '/crm/v3/objects/companies/batch/upsert', body: { inputs: [{ id: 'ahrq:1', idProperty: 'serif_account_key', properties: { name: 'X', hubspot_owner_id: 'synthetic-avery' } }] } }]);
    assert.equal('hubspot_owner_id' in sent[0].inputs[0].properties, false);
    assert.deepEqual(out.ownerMapped, [{ from: 'synthetic-avery', to: null }]);
  });
  it('a failed owners lookup is not cached, so the next write maps its owner', async () => {
    const sent: any[] = [];
    let ownerCalls = 0;
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async (url: any, init: any) => {
      if (String(url).includes('/crm/v3/owners')) {
        ownerCalls++;
        if (ownerCalls === 1) throw new TypeError('fetch failed: ECONNRESET');
        return new Response(JSON.stringify({ results: [{ id: '777', archived: false }] }), { status: 200 });
      }
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: '5' }), { status: 201 });
    });
    const task = [{ method: 'POST' as const, path: '/crm/v3/objects/tasks', body: { properties: { hs_task_subject: 'x', hubspot_owner_id: 'synthetic-avery' } } }];
    const first = await executeCrm(ctx, task);
    assert.deepEqual(first.ownerMapped, [{ from: 'synthetic-avery', to: null }]);
    const second = await executeCrm(ctx, task);
    assert.equal(ownerCalls, 2);
    assert.equal(sent[1].properties.hubspot_owner_id, '777');
    assert.deepEqual(second.ownerMapped, [{ from: 'synthetic-avery', to: '777' }]);
  });
  it('a failed write comes back with its status and HubSpot error, never as ok', async () => {
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async () => new Response('{"message":"Property values were not valid"}', { status: 400 }));
    const out = await executeCrm(ctx, [{ method: 'POST', path: '/crm/v3/objects/contacts/batch/upsert', body: { inputs: [] } }]);
    assert.equal(out.ok, false);
    assert.equal(out.responses?.[0].status, 400);
    assert.match(out.responses?.[0].error ?? '', /not valid/);
  });
  it('a repeat lead keeps the open task already on the contact instead of stacking a second one', async () => {
    const calls: string[] = [];
    let filters: any[] = [];
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async (url: any, init: any) => {
      const u = String(url).replace('https://api.hubapi.com', '');
      calls.push(`${init.method} ${u}`);
      if (u.endsWith('/tasks/search')) { filters = JSON.parse(init.body).filterGroups[0].filters; return new Response(JSON.stringify({ total: 1, results: [{ id: '99' }] }), { status: 200 }); }
      return new Response(JSON.stringify({ results: [{ id: '11' }] }), { status: 200 });
    });
    const out = await executeCrm(ctx, [
      { method: 'POST', path: '/crm/v3/objects/contacts/batch/upsert', body: {} },
      { method: 'POST', path: '/crm/v3/objects/tasks', body: { properties: { hs_task_subject: 'Respond now: Dana Whitfield' } } },
    ]);
    assert.deepEqual(filters.map((f: any) => [f.propertyName, f.operator, f.value]), [['hs_task_subject', 'EQ', 'Respond now: Dana Whitfield'], ['hs_task_status', 'NEQ', 'COMPLETED'], ['associations.contact', 'EQ', '11']]);
    assert.equal(calls.includes('POST /crm/v3/objects/tasks'), false);
    assert.equal(out.responses?.[1].reused, '99');
    assert.equal(out.ok, true);
  });
  it('with no open task on the contact, the task is created once', async () => {
    const calls: string[] = [];
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async (url: any, init: any) => {
      const u = String(url).replace('https://api.hubapi.com', '');
      calls.push(`${init.method} ${u}`);
      if (u.endsWith('/tasks/search')) return new Response(JSON.stringify({ total: 0, results: [] }), { status: 200 });
      return new Response(JSON.stringify({ results: [{ id: '11' }] }), { status: u.endsWith('/tasks') ? 201 : 200 });
    });
    await executeCrm(ctx, [
      { method: 'POST', path: '/crm/v3/objects/contacts/batch/upsert', body: {} },
      { method: 'POST', path: '/crm/v3/objects/tasks', body: { properties: { hs_task_subject: 'Respond now: Dana Whitfield' } } },
    ]);
    assert.equal(calls.filter(c => c === 'POST /crm/v3/objects/tasks').length, 1);
  });
  it('a failed task search still creates the task: a duplicate costs less than a missed follow-up', async () => {
    const calls: string[] = [];
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok' }, async (url: any, init: any) => {
      const u = String(url).replace('https://api.hubapi.com', '');
      calls.push(`${init.method} ${u}`);
      if (u.endsWith('/tasks/search')) return new Response('{"message":"internal error"}', { status: 500 });
      return new Response(JSON.stringify({ results: [{ id: '11' }] }), { status: u.endsWith('/tasks') ? 201 : 200 });
    });
    await executeCrm(ctx, [
      { method: 'POST', path: '/crm/v3/objects/contacts/batch/upsert', body: {} },
      { method: 'POST', path: '/crm/v3/objects/tasks', body: { properties: { hs_task_subject: 'Respond now: Dana Whitfield' } } },
    ]);
    assert.equal(calls.filter(c => c === 'POST /crm/v3/objects/tasks').length, 1);
  });
  it('docs/hubspot-properties.json matches the definitions in code', () => {
    const onDisk = JSON.parse(readFileSync(join(ROOT, 'docs', 'hubspot-properties.json'), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(propertyDefinitions())));
  });
});

describe('Slack payloads', () => {
  it('the Slack payload is extractive, tagged synthetic and marked dry-run', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo');
    const s = lead.alert.slack;
    assert.equal(s.channel, '@Avery');
    assert.equal(s.blocks[0].type, 'header');
    assert.match(s.blocks[0].text.text, /Tier A .* HSP/);
    const text = JSON.stringify(s);
    assert.doesNotMatch(text, /SYNTHETIC|prototype/, 'the alert carries no fixture banner; the flag stays on the lead');
    assert.match(text, /renegotiations start in January/);
    assert.equal(s.dryRun, true);
  });
  it('the brief quotes the prospect or lists activity facts, and states registry facts from code', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'sample_signup', { message: undefined, usage: [{ event: 'session_start', at: '2026-11-05T14:00:00Z' }, { event: 'search', code: 'CPT 27447', at: '2026-11-05T14:05:00Z' }] });
    const ev = adapt('sample_signup', lead.raw, lead.receivedAt);
    const n = normalizeEvent(ev, registryLookups(ctx.db));
    const brief = buildBrief(ev, n, lead.resolution, lead.qualification);
    assert.match(brief.text, /Activity: 1 session\(s\), 1 search\(es\)/);
    assert.match(brief.org, /AHRQ health system, 33 hospitals/);
    const quoted = buildBrief({ ...ev, source: 'calendly_demo' }, { ...n, message: 'We need peer rates.' }, lead.resolution, lead.qualification);
    assert.match(quoted.text, /They wrote: "We need peer rates\."/);
    assert.ok(buildSlackPayload({ brief, score: lead.score, route: lead.route, timeToRouteMs: 5, synthetic: true, afterHours: false }).blocks.length === 2);
  });
});
