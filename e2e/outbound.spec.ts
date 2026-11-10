// The Outbound tab in the browser, on the server's invented rate file (test/fixtures/rates-mini.csv: 12 groups, Harborlight the
// one platform, one entity confirmed and one not). Nothing here sends a lead, so the other spec's counts are untouched.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/** Any console error, failed request or HTTP 4xx/5xx fails the test, as in the send-a-lead spec. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') problems.push(`console error: ${m.text()} (${m.location().url})`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });
  return problems;
}

test('the Outbound tab shows the finding, the chart and the targets, and a group opens with its marked draft', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();
  await page.getByRole('tab', { name: 'Outbound' }).click();
  await expect(page.getByRole('tab', { name: 'Outbound' })).toHaveAttribute('aria-selected', 'true');

  // the finding in one line, the figures, and the chart
  await expect(page.getByText(/^Of the \d+ groups with 50 or fewer clinicians, \d+ are paid a whole percent of one \$\d+\.\d{2} base, and the band's median is \d+% of Medicare\. Groups with over 500 clinicians sit at a median of \d+%\.$/)).toBeVisible();
  await expect(page.locator('.ob-stat', { hasText: 'Groups' }).first().locator('.ob-stat-value')).toHaveText('12');
  await expect(page.locator('.ob-stat', { hasText: 'On the rate card' }).locator('.ob-stat-value')).toHaveText(/^\d+$/);
  await expect(page.locator('.ob-stat', { hasText: 'On a conversion factor' }).locator('.ob-stat-value')).toHaveText(/^\d+$/);
  await expect(page.getByRole('group', { name: 'Median percent of Medicare by size band' }).locator('.ob-band-val')).toHaveCount(3);
  const chart = page.getByRole('img', { name: 'Rate against size' });
  await expect(chart).toBeVisible();
  await expect(chart.locator('.pt')).toHaveCount(12);
  await expect(page.getByLabel('Chart key')).toContainText('Medicare 100%');

  // Targets is the default filter: the two Harborlight entities
  const table = page.getByRole('table').filter({ hasText: 'Contract form' });
  await expect(page.getByRole('button', { name: /^Targets/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(table.locator('tbody tr')).toHaveCount(2);

  // opening the confirmed one shows its facts, its marked draft and the draft state, and the HubSpot request stays collapsed
  await table.getByRole('button', { name: 'HARBORLIGHT TELEPSYCH PLLC' }).click();
  const panel = page.getByRole('complementary', { name: 'Group detail' });
  await expect(panel.getByText('Draft ready').first()).toBeVisible();
  await expect(panel.locator('.ob-nothing')).toContainText('Nothing is sent from here.');
  await expect(panel.getByText("Harborlight's UHC rate in Texas: 79% of Medicare")).toBeVisible();
  await expect(panel.locator('.ob-mail-body mark.ins').first()).toBeVisible();
  await expect(panel.locator('.ob-mail-body .ph-open').first()).toHaveText('{first_name}');
  await expect(panel.getByRole('table', { name: 'Every inserted value and where it came from' }).locator('tbody tr').first()).toBeVisible();
  await expect(panel.locator('details.ob-hs')).not.toHaveAttribute('open', '');
  await panel.getByText('HubSpot request that would be sent').click();
  await expect(panel.getByText('/crm/v3/objects/companies/batch/upsert')).toBeVisible();

  // the unconfirmed entity is blocked, with the reason
  await table.getByRole('button', { name: 'HARBORLIGHT TELEPSYCH OK' }).click();
  await expect(panel.locator('.ob-state.is-blocked')).toContainText('not confirmed');

  // All shows every group, and a header click sorts: Rate, largest first, then smallest first
  await page.getByRole('button', { name: /^All/ }).click();
  await expect(table.locator('tbody tr')).toHaveCount(12);
  const rates = async () => (await table.locator('tbody td.ob-c-rate').allTextContents()).map(t => Number(t.replace('$', '')));
  await page.getByRole('button', { name: 'Rate' }).click();
  expect(await rates()).toEqual([...(await rates())].sort((a, b) => b - a));
  await page.getByRole('button', { name: 'Rate' }).click();
  expect(await rates()).toEqual([...(await rates())].sort((a, b) => a - b));
  await expect(table.getByRole('columnheader', { name: /Rate/ })).toHaveAttribute('aria-sort', 'ascending');

  // the page itself never scrolls sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('with no rate file loaded the tab says so and shows the command that fetches it', async ({ page }) => {
  const problems = watch(page);
  await page.route('**/api/outbound', route => route.fulfill({
    json: { loaded: false, status: 'missing', reason: 'no rate file at data/rates/mrf_rate_search_export.csv', file: { path: 'data/rates/mrf_rate_search_export.csv' }, patterns: null, summary: null, groups: [] },
  }));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Outbound' }).click();
  await expect(page.getByRole('heading', { name: 'No rate file is loaded' })).toBeVisible();
  await expect(page.getByText('no rate file at data/rates/mrf_rate_search_export.csv')).toBeVisible();
  await expect(page.locator('.ob-cmd')).toHaveText('npm run rates:fetch');
  await expect(page.getByRole('img', { name: 'Rate against size' })).toHaveCount(0);
  expect(problems, problems.join('\n')).toEqual([]);
});
