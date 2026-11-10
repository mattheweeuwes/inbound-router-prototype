// "Send a lead" through the cockpit, as a person would: open the page on its Overview, wait for it to be live, fill the form, submit,
// land on the Lead stream with the new lead, read the trail, then see the Overview count it.
// The organization resolves offline by domain from the server's registry (the mini registry, test/fixtures/registry-mini.sql). Nothing here depends on the time of day: the routing outcome
// (alert now, queue, next business open) varies with the clock, so the test checks that a decision exists, not which one.
import { expect, test, type ConsoleMessage } from '@playwright/test';

const LEAD = {
  name: 'Dana Whitfield-E2E',
  email: 'dwhitfield.e2e@intermountainhealthcare.org',
  title: 'VP Managed Care Contracting',
  company: 'Intermountain Health',
  state: 'UT',
  message: 'Our commercial renegotiations start in January.',
};

test('a lead sent through the cockpit is routed, with its decision trail and a dry-run CRM sync', async ({ page }) => {
  const problems: string[] = [];
  // Any console error, failed request or HTTP 4xx/5xx fails the test. Before any eval has run, /api/eval answers 200 with
  // { recorded: false }, so a fresh install has no expected failures to excuse.
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') problems.push(`console error: ${m.text()} (${m.location().url})`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });

  // The page opens on the Overview, starts in sample mode and switches to live once the API answers; sending is only possible live.
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Live API')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Leads in' }).getByText('0', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Send a test lead' }).click();
  const form = page.getByRole('complementary', { name: 'Send a test lead' });
  await form.getByLabel('Name', { exact: true }).fill(LEAD.name);
  await form.getByLabel('Work email').fill(LEAD.email);
  await form.getByLabel('Title', { exact: true }).fill(LEAD.title);
  await form.getByLabel('Company').fill(LEAD.company);
  await form.getByLabel('State').fill(LEAD.state);
  await form.getByLabel('What are they hoping to solve?').fill(LEAD.message);
  await form.getByRole('button', { name: 'Send through the router' }).click();

  // Sending lands on the Lead stream. The lead appears there (the router title-cases names, hence the case-insensitive match)
  // and is opened by clicking it.
  await expect(page.getByRole('tab', { name: 'Lead stream' })).toHaveAttribute('aria-selected', 'true');
  const row = page.getByRole('listbox', { name: 'Leads' }).getByRole('option', { name: new RegExp(LEAD.name, 'i') });
  await expect(row).toBeVisible();
  await row.click();

  // The decision trail: the person, the resolved organization, a routing decision, and a CRM sync that was not sent.
  // The registry names the organization (its own spelling, "Intermountain Healthcare"); the form's company field is not what is shown.
  await expect(page.getByText(new RegExp(`^${LEAD.title} · Intermountain Health\\w* · ${LEAD.email.replace('.', '\\.')}`))).toBeVisible();
  await expect(page.getByText('Resolved', { exact: true })).toBeVisible();
  await expect(page.getByText('Verified org domain · high confidence')).toBeVisible();
  await expect(page.getByText('Routed', { exact: true })).toBeVisible();
  await expect(page.getByText(/· rule R\d/)).toBeVisible();
  await expect(page.getByText(/^Routed in .+ from the webhook/)).toBeVisible();
  await expect(page.getByText(/^planned · \d+ requests?$/)).toBeVisible();
  await expect(page.getByText(/live, sent/)).toHaveCount(0);

  // The Overview counts it: one lead in, from one signed delivery.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByRole('group', { name: 'Leads in' }).getByText('1', { exact: true })).toBeVisible();
  await expect(page.getByText('1 signed delivery passed the signature check')).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
});

// The loop: a lead from an organization that is in the rate file carries that group's rate line in its trail, with a way into the
// Outbound tab. The server's invented rate file has Northwind Psychiatry PLLC in Oklahoma; it is matched by name and state.
test('a lead from an organization in the rate file shows the rate line the router added, and the preset for it is in the form', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') problems.push(`console error: ${m.text()} (${m.location().url})`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });

  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();
  await page.getByRole('button', { name: 'Send a test lead' }).click();
  const form = page.getByRole('complementary', { name: 'Send a test lead' });

  // the drawer has a preset for an organization in the real rate file; it fills a synthetic person
  await form.getByRole('button', { name: 'Organization in the rate file' }).click();
  await expect(form.getByLabel('Company')).toHaveValue('INTEGRIS Health');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Morgan Reyes');

  await form.getByLabel('Name', { exact: true }).fill('Pat Okafor-E2E');
  await form.getByLabel('Work email').fill('pokafor.e2e@northwind-psych.example');
  await form.getByLabel('Title', { exact: true }).fill('Director of Payer Contracting');
  await form.getByLabel('Company').fill('Northwind Psychiatry PLLC');
  await form.getByLabel('State').fill('OK');
  await form.getByLabel('What are they hoping to solve?').fill('We renegotiate with UnitedHealthcare next quarter and want peer rates.');
  await form.getByRole('button', { name: 'Send through the router' }).click();

  const row = page.getByRole('listbox', { name: 'Leads' }).getByRole('option', { name: /Pat Okafor-E2E/i });
  await row.click();
  const step = page.locator('.stage', { has: page.locator('.stage-name', { hasText: /^Their rates$/ }) });
  await expect(step).toBeVisible();
  await expect(step.getByText(/Their UHC Choice Plus rate for 90837 \(Aug 2026\): \$\d+\.\d\d, \d+% of Medicare/)).toBeVisible();
  // the Slack preview in the Alert step carries the same line as its own field
  await expect(page.locator('.chat-fields').getByText('Their rates')).toBeVisible();

  // the link opens that group in the Outbound tab
  await page.getByRole('link', { name: 'Open in Outbound' }).click();
  await expect(page.getByRole('tab', { name: 'Outbound' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('complementary', { name: 'Group detail' }).getByText('NORTHWIND PSYCHIATRY PLLC').first()).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Group detail' }).getByText('Not a target').first()).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
});
