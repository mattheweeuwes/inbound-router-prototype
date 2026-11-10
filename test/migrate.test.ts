import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../src/config';
import { computeDashboard } from '../src/dashboard';
import { migrate } from '../src/db';
import { leadDetail, listLeads } from '../src/view';
import { testCtx } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'router-migrate-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const INIT = readFileSync(join(ROOT, 'sql', 'migrations', '001_init.sql'), 'utf8');
const CLAIMER = '11111111-1111-4111-8111-111111111111';
const PENDING = '22222222-2222-4222-8222-222222222222';
const SIGNAL = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = 'ahrq:SYS-INTERMTN';
const requests = [{ method: 'POST', path: '/crm/v3/objects/contacts/batch/upsert', body: { inputs: [{ id: 'a@b.example', idProperty: 'email', properties: {} }] } }];

/** A database exactly as the code before the migration runner left it: only 001, claims parsed from text, retryPending in crm_json. */
function oldDatabase(path: string) {
  const db = new DatabaseSync(path);
  db.exec(INIT);
  const event = db.prepare(`INSERT INTO lead_events (id, source, source_event_id, received_at, synthetic, raw_json) VALUES (?, 'calendly_demo', ?, ?, 1, '{}')`);
  const lead = db.prepare(`INSERT INTO leads (id, status, first_name, last_name, email, account_id, tier, route_action, route_team, owner, crm_json, alert_json, created_at, updated_at)
    VALUES (?, 'done', 'Dana', 'Whitfield', ?, ?, 'A', 'rep_alert', 'HSP', 'Avery Smith', ?, '{"slack":null,"suppressed":false}', ?, ?)`);
  event.run(CLAIMER, 'e1', '2026-11-05T15:00:00.000Z');
  lead.run(CLAIMER, 'dana@intermountainhealthcare.org', ACCOUNT, JSON.stringify({ mode: 'dry_run', requests, skipped: null }), '2026-11-05T15:00:01.000Z', '2026-11-05T15:00:02.000Z');
  event.run(PENDING, 'e2', '2026-11-05T16:00:00.000Z');
  lead.run(PENDING, 'sam@intermountainhealthcare.org', ACCOUNT, JSON.stringify({ mode: 'live', requests, skipped: null, ok: false, error: 'fetch failed: ECONNRESET', retryPending: true }), '2026-11-05T16:00:01.000Z', '2026-11-05T16:00:02.000Z');
  event.run(SIGNAL, 'e3', '2026-11-05T17:00:00.000Z');
  db.prepare(`INSERT INTO leads (id, status, created_at, updated_at) VALUES (?, 'done', ?, ?)`).run(SIGNAL, '2026-11-05T17:00:01.000Z', '2026-11-05T17:00:01.000Z');
  db.prepare(`INSERT INTO accounts (id, name, segment, owner, intent_points, created_at, updated_at) VALUES (?, 'Intermountain Health', 'health_system', 'Avery Smith', 6, ?, ?)`).run(ACCOUNT, '2026-11-05T15:00:00.000Z', '2026-11-05T15:00:00.000Z');
  const signal = db.prepare(`INSERT INTO account_signals (account_id, type, detail, at) VALUES (?, ?, ?, ?)`);
  signal.run(ACCOUNT, 'claim', `[${CLAIMER}] Avery Smith claimed this account on a rep alert to Dana Whitfield`, '2026-11-05T15:00:00.000Z');
  signal.run(ACCOUNT, 'web_intent', `[${SIGNAL}] 2 page view(s), 1 visitor(s): /a, /b`, '2026-11-05T17:00:00.000Z');
  db.close();
}

describe('the migration runner', () => {
  it('a database from before the runner opens, migrates, and renders with nothing lost', () => {
    const path = join(dir, 'old.sqlite');
    oldDatabase(path);
    const ctx = testCtx({ appDb: path });
    const applied = (ctx.db.prepare(`SELECT name FROM schema_migrations ORDER BY name`).all() as { name: string }[]).map(r => r.name);
    assert.deepEqual(applied, ['001_init.sql', '002_claims_outbox_retries.sql', '003_second_opinion.sql', '004_outbound_rates.sql', '005_usage_deals.sql', '006_list_digests.sql', '007_enterprise_referrals.sql', '008_rate_link_decisions.sql']);

    // claims: in their own table, owner from the account, with the two-word name intact
    assert.deepEqual({ ...(ctx.db.prepare(`SELECT lead_id, account_id, owner, at FROM account_claims`).get() as object) }, { lead_id: CLAIMER, account_id: ACCOUNT, owner: 'Avery Smith', at: '2026-11-05T15:00:00.000Z' });
    const signals = (ctx.db.prepare(`SELECT type, lead_id, detail FROM account_signals ORDER BY id`).all() as object[]).map(r => ({ ...r }));
    assert.deepEqual(signals, [
      { type: 'claim', lead_id: CLAIMER, detail: 'Avery Smith claimed this account on a rep alert to Dana Whitfield' },
      { type: 'web_intent', lead_id: SIGNAL, detail: '2 page view(s), 1 visitor(s): /a, /b' },
    ]);

    // the write that was waiting for a boot retry is in the outbox, due now, and its record says so
    const box = { ...(ctx.db.prepare(`SELECT lead_id, state, attempts, next_attempt_at, last_error, plan_json FROM crm_outbox`).get() as { plan_json: string }) };
    assert.deepEqual({ ...box, plan_json: JSON.parse(box.plan_json) }, { lead_id: PENDING, state: 'pending', attempts: 0, next_attempt_at: 0, last_error: 'fetch failed: ECONNRESET', plan_json: { requests, skipped: null } });
    const pending = leadDetail(ctx, PENDING)!;
    assert.deepEqual(pending.crm, { mode: 'live', requests, skipped: null, ok: false, error: 'fetch failed: ECONNRESET', delivery: 'retrying' });
    assert.deepEqual(leadDetail(ctx, CLAIMER)!.crm, { mode: 'dry_run', requests, skipped: null }, 'a settled record is untouched');

    // accepted_at comes from the lead's created_at; the business time is unchanged
    assert.deepEqual({ ...(ctx.db.prepare(`SELECT received_at, accepted_at FROM lead_events WHERE id = ?`).get(CLAIMER) as object) }, { received_at: '2026-11-05T15:00:00.000Z', accepted_at: '2026-11-05T15:00:01.000Z' });

    // the cockpit's reads
    assert.equal(listLeads(ctx).length, 3);
    const account = leadDetail(ctx, CLAIMER)!.account as { owner: string; signals: { type: string; detail: string }[] };
    assert.equal(account.owner, 'Avery Smith');
    assert.deepEqual(account.signals.map(s => s.detail), ['2 page view(s), 1 visitor(s): /a, /b', 'Avery Smith claimed this account on a rep alert to Dana Whitfield']);
    const d = computeDashboard(ctx);
    assert.equal(d.window.leads, 3);
    assert.deepEqual([d.hubspot.waiting, d.hubspot.dead, d.hubspot.failed], [1, 0, 0]);
    ctx.db.close();
  });

  it('opening a migrated database again applies nothing', () => {
    const path = join(dir, 'again.sqlite');
    oldDatabase(path);
    testCtx({ appDb: path }).db.close();
    const db = new DatabaseSync(path);
    assert.deepEqual(migrate(db, join(ROOT, 'sql', 'migrations')), []);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM crm_outbox`).get() as { n: number }).n, 1, 'the backfill did not run twice');
    db.close();
  });

  it('a later file that alters a table runs once, and a failing file leaves nothing half-applied', () => {
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir);
    copyFileSync(join(ROOT, 'sql', 'migrations', '001_init.sql'), join(migDir, '001_init.sql'));
    writeFileSync(join(migDir, '002_note.sql'), 'ALTER TABLE leads ADD COLUMN note TEXT;');
    const db = new DatabaseSync(':memory:');
    assert.deepEqual(migrate(db, migDir), ['001_init.sql', '002_note.sql']);
    assert.deepEqual(migrate(db, migDir), [], 'an ALTER that ran is not run again');
    writeFileSync(join(migDir, '003_broken.sql'), 'ALTER TABLE leads ADD COLUMN extra TEXT; ALTER TABLE nope ADD COLUMN x TEXT;');
    assert.throws(() => migrate(db, migDir), /no such table: nope/);
    const cols = (db.prepare(`SELECT name FROM pragma_table_info('leads')`).all() as { name: string }[]).map(r => r.name);
    assert.ok(cols.includes('note'));
    assert.equal(cols.includes('extra'), false, 'the first statement of the failed file was rolled back');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '003_broken.sql'`).get() as { n: number }).n, 0);
    db.close();
  });
});
