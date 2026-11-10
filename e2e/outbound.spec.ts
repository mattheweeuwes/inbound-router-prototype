// The Outbound tab in the browser, on the server's invented rate file (test/fixtures/rates-mini.csv: 16 groups, Harborlight the
// one platform, one entity confirmed and one not; in Amarillo, Canyon Lark Health in the system-gap play, Pecos Vale Physicians
// with a probable link, and Tallowmere Health Partners under a fictional CRM customer's name). Nothing here sends a lead, so the
// other specs' counts are untouched; the link decision it records lives in this run's throwaway database.
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
  await expect(page.locator('.ob-stat', { hasText: 'Groups' }).first().locator('.ob-stat-value')).toHaveText('16');
  await expect(page.locator('.ob-stat', { hasText: 'On the rate card' }).locator('.ob-stat-value')).toHaveText(/^\d+$/);
  await expect(page.locator('.ob-stat', { hasText: 'On a conversion factor' }).locator('.ob-stat-value')).toHaveText(/^\d+$/);
  await expect(page.getByRole('group', { name: 'Median percent of Medicare by size band' }).locator('.ob-band-val')).toHaveCount(3);
  const chart = page.getByRole('img', { name: 'Rate against size' });
  await expect(chart).toBeVisible();
  await expect(chart.locator('.pt')).toHaveCount(16);
  await expect(page.getByLabel('Chart key')).toContainText('Medicare 100%');

  // In a play is the default filter: the two Harborlight entities and the system-gap group
  const table = page.getByRole('table').filter({ hasText: 'Contract form' });
  await expect(page.getByRole('button', { name: /^In a play/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(table.locator('tbody tr')).toHaveCount(3);

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
  await expect(table.locator('tbody tr')).toHaveCount(16);
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

test('a person confirms a probable link, its system-gap draft is ready and exported, and a suppressed group shows who has it', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Outbound' }).click();
  const work = page.getByRole('group', { name: 'Outbound work' });
  const tile = (label: string) => work.locator('.ob-stat', { hasText: label }).locator('.ob-stat-value');
  await expect(tile('Drafts ready: Platform')).toHaveText('1');
  await expect(tile('Drafts ready: System gap')).toHaveText('1');
  await expect(tile('Suppressed')).toHaveText('1');
  await expect(tile('Links to confirm')).toHaveText('1');
  const before = await (await page.request.get('/api/outbound/export.csv')).text();
  expect(before).not.toContain('900000014');

  // the panel shows the probable link with its candidate, score and state
  const links = page.getByRole('region', { name: /Links to confirm/ });
  const item = links.locator('li.ob-link', { hasText: 'PECOS VALE PHYSICIANS PLLC' });
  await expect(item).toContainText('Pecos Vale Health System');
  await expect(item).toContainText('TX · score 0.48');

  // a decision needs a name, since sign-in is not built
  await item.getByRole('button', { name: 'Confirm' }).click();
  await expect(links.locator('.ob-link-msg.is-error')).toContainText('Type your name in Deciding as first');
  await links.getByLabel('Deciding as').fill('Pat Okafor (test)');
  await item.getByRole('button', { name: 'Confirm' }).click();
  await expect(links.locator('.ob-link-msg')).toContainText('Confirmed for PECOS VALE PHYSICIANS PLLC.');
  await expect(tile('Drafts ready: System gap')).toHaveText('2');
  await expect(tile('Links to confirm')).toHaveText('0');

  // the group now opens with a ready system-gap draft under the confirmed system's name
  const table = page.getByRole('table').filter({ hasText: 'Contract form' });
  await page.getByRole('button', { name: /^System gap/ }).click();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await table.getByRole('button', { name: 'PECOS VALE PHYSICIANS PLLC' }).click();
  const panel = page.getByRole('complementary', { name: 'Group detail' });
  await expect(panel.locator('.ob-state.is-ready')).toBeVisible();
  await expect(panel.getByText("Pecos Vale Health System's UHC rate for 90837 in Amarillo: 81% of Medicare")).toBeVisible();
  await expect(panel.getByText('Confirmed by Pat Okafor (test)', { exact: false })).toBeVisible();

  // and the export has it, with the export link on the tab pointing at the same file
  await expect(page.getByRole('link', { name: /Export the 3 ready drafts/ })).toHaveAttribute('href', '/api/outbound/export.csv');
  const after = await (await page.request.get('/api/outbound/export.csv')).text();
  expect(after).toContain("900000014,ein:900000014;ahrq:SYS-PECOSVALE,system_gap,HSP,PECOS VALE PHYSICIANS PLLC,Amarillo,TX");

  // a suppressed group says who has it, in the table and in its detail
  await page.getByRole('button', { name: /^All/ }).click();
  const row = table.locator('tr', { hasText: 'TALLOWMERE HEALTH PARTNERS' });
  await expect(row.locator('.ob-c-status')).toContainText('Suppressed · Jordan has it');
  await row.getByRole('button', { name: 'TALLOWMERE HEALTH PARTNERS' }).click();
  await expect(panel.locator('.ob-held')).toContainText('Jordan has it.');
  await expect(panel.locator('.ob-held')).toContainText('Tallowmere Health is a customer in the CRM');
  expect(problems, problems.join('\n')).toEqual([]);
});

// The one probable link was confirmed by the test above and the server keeps it, so this test starts from a decided link.
test('a person takes a decision back and the count returns, and a new decision leaves a line with an Undo where the row was', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/#outbound');
  await expect(page.getByText('Live API')).toBeVisible();
  const work = page.getByRole('group', { name: 'Outbound work' });
  const waiting = work.locator('.ob-stat', { hasText: 'Links to confirm' }).locator('.ob-stat-value');
  await expect(waiting).toHaveText('0');
  const links = page.getByRole('region', { name: /Links to confirm/ });
  await expect(links.getByText('No probable link is waiting.')).toBeVisible();

  // the earlier decision is in the collapsed Decided list, with who decided it and an Undo
  await links.getByRole('button', { name: /^Decided \(1\)/ }).click();
  const decided = links.locator('.ob-decided-row', { hasText: 'PECOS VALE PHYSICIANS PLLC' });
  await expect(decided).toContainText('Pat Okafor (test)');
  await decided.getByRole('button', { name: 'Undo' }).click();
  await expect(waiting).toHaveText('1');
  const item = links.locator('li.ob-link', { hasText: 'PECOS VALE PHYSICIANS PLLC' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('Would put the group in a play');
  await expect(item).toContainText('Confirming puts it in the System gap play');
  // the draft left the export with it
  expect(await (await page.request.get('/api/outbound/export.csv')).text()).not.toContain('900000014');

  // a decision without a name sends the person to the name box, with the message beside the row
  await item.getByRole('button', { name: 'Confirm' }).click();
  await expect(item.locator('.ob-link-msg.is-error')).toContainText('Type your name in Deciding as first');
  await expect(links.getByLabel('Deciding as')).toBeFocused();
  await links.getByLabel('Deciding as').fill('Sam Reviewer (test)');

  // confirming leaves the page where it was: the row becomes one line with an Undo
  await links.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  await item.getByRole('button', { name: 'Confirm' }).click();
  const line = links.locator('li.ob-link-done');
  await expect(line).toContainText('Confirmed for PECOS VALE PHYSICIANS PLLC.');
  await expect(waiting).toHaveText('0');
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - y)).toBeLessThan(40);

  // and Undo takes it back: the row returns and the count with it
  await line.getByRole('button', { name: 'Undo' }).click();
  await expect(waiting).toHaveText('1');
  await expect(links.locator('li.ob-link', { hasText: 'PECOS VALE PHYSICIANS PLLC' })).toBeVisible();
  await expect(links.locator('li.ob-link-done')).toHaveCount(0);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the groups filter by status, the view is a link, and a link opens it', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/#outbound');
  await expect(page.getByText('Live API')).toBeVisible();
  const status = page.getByRole('group', { name: 'Filter by status' });
  // each status chip has its count, taken over the groups the other chips leave
  for (const name of ['Ready', 'Blocked', 'Suppressed', 'Link to confirm', 'Not a target']) await expect(status.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  const table = page.getByRole('table').filter({ hasText: 'Contract form' });
  await status.getByRole('button', { name: /^Link to confirm/ }).click();
  // a link to confirm is in no play, so the play chip widens to All rather than showing an empty table
  await expect(page.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr').first()).toContainText('PECOS VALE PHYSICIANS PLLC');
  await expect(page).toHaveURL(/#outbound\?status=link$/);
  await table.getByRole('button', { name: 'PECOS VALE PHYSICIANS PLLC' }).click();
  await expect(page).toHaveURL(/ein=900000014/);

  // the link opens the same view in a new page
  const link = page.url();
  const other = await page.context().newPage();
  await other.goto(link);
  await expect(other.getByRole('complementary', { name: 'Group detail' })).toContainText('PECOS VALE PHYSICIANS PLLC');
  await expect(other.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: /^Link to confirm/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(other.getByRole('table').filter({ hasText: 'Contract form' }).locator('tbody tr')).toHaveCount(1);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('at 390 px the Outbound tab, its work tiles and the links panel fit with no sideways scroll', async ({ page }) => {
  const problems = watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Outbound' }).click();
  await expect(page.getByRole('group', { name: 'Outbound work' })).toBeVisible();
  await expect(page.getByRole('region', { name: /Links to confirm/ })).toBeVisible();
  await page.getByRole('button', { name: /^All/ }).click();
  await expect(page.locator('tr', { hasText: 'TALLOWMERE HEALTH PARTNERS' }).locator('.ob-c-status')).toContainText('Jordan has it');
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
