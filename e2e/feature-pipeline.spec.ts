// The Feature to pipeline tab in the browser, on the server's synthetic usage fixtures (fixtures/usage: 12 fictional accounts,
// 22 deals, 427 events). Nothing here sends a lead or posts an event, so the other specs' counts are untouched.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/** Any console error, failed request or HTTP 4xx/5xx fails the test, as in the other specs. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') problems.push(`console error: ${m.text()} (${m.location().url})`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });
  return problems;
}

test('the Feature to pipeline tab says it is influence, not cause, shows counts beside rates, and lists the expansion signals', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();
  await page.getByRole('tab', { name: 'Feature to pipeline' }).click();
  await expect(page.getByRole('tab', { name: 'Feature to pipeline' })).toHaveAttribute('aria-selected', 'true');

  // the caveat is on the page before any number is read, and no fixture banner is
  await expect(page.locator('.fp-syn-usage, .fp-syn-interest')).toHaveCount(0);
  await expect(page.getByRole('note').filter({ hasText: 'Influence, not proof of cause.' })).toBeVisible();
  await expect(page.locator('.ob-line')).toContainText('22 of 22 deals had an account using at least one tracked feature');
  await expect(page.getByRole('group', { name: 'The data behind the tab' }).locator('.ob-stat').first().locator('.ob-stat-value')).toHaveText('22');

  // one bar and one table row per feature; the biggest first
  const bars = page.locator('.fp-bar-row');
  await expect(bars).toHaveCount(7);
  await expect(bars.first()).toContainText('Signal search');
  const table = page.getByRole('table').filter({ hasText: 'Win rate with use' });
  await expect(table.locator('tbody tr')).toHaveCount(7);
  await expect(table.locator('tbody tr').first()).toContainText('9 of 15 closed');
  await expect(table.locator('tbody tr').first()).toContainText('2 of 2 closed');
  await expect(table.locator('tbody tr').first().getByText('small sample')).toBeVisible();

  // picking another feature changes the deals under it
  await expect(page.getByRole('heading', { name: 'Deals around Signal search' })).toBeVisible();
  await table.getByRole('button', { name: 'Quality data preview' }).click();
  await expect(page.getByRole('heading', { name: 'Deals around Quality data preview' })).toBeVisible();
  await expect(page.locator('.fp-deal-table tbody tr')).toHaveCount(6);
  await expect(page.locator('.fp-deal-table .fp-addon').first()).toBeVisible();

  // Signal Ask is in preview with no launch date: the table says so, adoption is n/a, and nobody has asked yet on a fresh server
  const ask = table.locator('tbody tr').filter({ hasText: 'Signal Ask' });
  await expect(ask).toContainText('in preview, no launch date');
  await expect(ask).toContainText('not launched');
  await expect(table.getByRole('columnheader', { name: 'Interest from inbound' })).toBeVisible();
  await table.getByRole('button', { name: 'Signal Ask' }).click();
  await expect(page.getByRole('heading', { name: 'Who asked for Signal Ask' })).toBeVisible();
  await expect(page.getByText('Nobody in the lead stream has asked for this feature.')).toBeVisible();

  // the two expansion signals, with the HubSpot request collapsed
  const signals = page.locator('.fp-signal');
  await expect(signals).toHaveCount(2);
  await expect(signals.first()).toContainText('Brindlewood Mutual Health');
  await expect(signals.first()).toContainText('5 uses of Quality data preview in the 30 days to 2026-11-06, by 3 people');
  await expect(signals.first().locator('details.ob-hs')).not.toHaveAttribute('open', '');
  await signals.first().getByText('HubSpot requests', { exact: true }).click();
  await signals.first().getByText('/crm/v3/objects/tasks').click();
  await expect(signals.first().locator('pre.json').last()).toContainText('Expansion signal: Brindlewood Mutual Health previewed Provider quality data');

  // the page itself never scrolls sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the tab reflows to a phone: no sideways scroll, and the caveat stays on the page', async ({ page }) => {
  const problems = watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Feature to pipeline' }).click();
  await expect(page.locator('.fp-caveat')).toBeVisible();
  await expect(page.locator('.fp-caveat')).toContainText('Influence, not proof of cause.');
  await expect(page.locator('.fp-bar-row')).toHaveCount(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(problems, problems.join('\n')).toEqual([]);
});
