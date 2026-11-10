// A named referral, as sales and marketing would see it: a lead sent through the cockpit names who recommended Serif, its trail
// and Slack preview say who referred them and whose customer that is, and the Overview's Named referrals panel ranks the referrer.
// Wrenfield Health is a fictional customer in the CRM mirror, so this does not depend on the registry the server picked.
import { expect, test, type ConsoleMessage } from '@playwright/test';

test('a named referral is captured, shown in the alert, and ranked on the Overview', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') problems.push(`console error: ${m.text()} (${m.location().url})`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });

  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();
  await page.getByRole('button', { name: 'Send a test lead' }).click();
  const form = page.getByRole('complementary', { name: 'Send a test lead' });
  await form.getByLabel('Name', { exact: true }).fill('Riley Banks-E2E');
  await form.getByLabel('Work email').fill('rbanks.e2e@intermountainhealthcare.org');
  await form.getByLabel('Title', { exact: true }).fill('Director, Payer Contracting');
  await form.getByLabel('Company').fill('Intermountain Health');
  await form.getByLabel('State').fill('UT');
  await form.getByLabel('What are they hoping to solve?').fill('We renegotiate in Q1. The contracting VP at Wrenfield Health recommended you.');
  await form.getByRole('button', { name: 'Send through the router' }).click();

  const row = page.getByRole('listbox', { name: 'Leads' }).getByRole('option', { name: /Riley Banks-E2E/i });
  await row.click();
  // the Slack preview carries the referral as its own field, with the referrer's owner
  const fields = page.locator('.chat-fields');
  await expect(fields.getByText('Referral', { exact: true })).toBeVisible();
  await expect(fields.getByText(/Wrenfield Health, a customer owned by Avery/)).toBeVisible();

  // the Overview ranks the referrer, marked as a customer, beside everyone else's numbers
  await page.getByRole('tab', { name: 'Overview' }).click();
  const card = page.locator('article[data-card="referrals"]');
  await expect(card.getByRole('heading', { name: 'Named referrals' })).toBeVisible();
  const ranked = card.getByRole('list', { name: 'Referrers by leads sent' });
  await expect(ranked.getByText('Wrenfield Health')).toBeVisible();
  await expect(ranked.getByText('customer', { exact: true })).toBeVisible();
  await expect(ranked.getByText('owner Avery')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Named referrals beside everyone else' }).getByText('Named a referrer')).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
});
