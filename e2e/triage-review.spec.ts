// Needs a person, as a reviewer uses it: a lead whose company matches two health systems about equally waits there with its
// candidates; the reviewer types their name, chooses one, and the item is replaced in place by one line saying where the
// lead went, the tab's count drops by one, focus moves on, and the decision is listed under Decided with who made it.
// (Named to run after the other specs, which expect a fresh server with no leads.)
import { expect, test, type ConsoleMessage } from '@playwright/test';

test('a reviewer picks one of two candidates, and the item leaves with the count', async ({ page, request }) => {
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.method()} ${r.url()}`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });

  // free mail and no state: "Baptist Health" ties between the Arkansas and Kentucky systems in the mini registry
  const sent = await request.post('/api/demo/submit', {
    data: { source: 'calendly_demo', name: 'Lauren Price-E2E', email: 'lprice.e2e@gmail.com', title: 'Managed Care Director', company: 'Baptist Health', message: 'I am benchmarking commercial rates.', wait: true },
  });
  expect(sent.ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();
  await page.getByRole('tab', { name: /Needs a person/ }).click();
  const count = page.locator('#reviewCount');
  const card = page.locator('.rcard', { hasText: 'Lauren Price-E2E' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Which organization is it?')).toBeVisible();
  const before = Number(await count.textContent());
  expect(before).toBeGreaterThan(0);

  // a decision needs a name, and says so where the person is looking
  const arkansas = card.getByRole('row', { name: /AR/ }).getByRole('button', { name: 'Use this account' });
  await arkansas.click();
  await expect(card.getByRole('alert')).toHaveText('Type your name in Deciding as first.');
  await expect(page.getByLabel('Deciding as')).toBeFocused();
  await page.getByLabel('Deciding as').fill('Riley E2E');

  const y = await page.evaluate(() => window.scrollY);
  await arkansas.click();
  await expect(card).toContainText(/Routed: tier [A-D], /);
  await expect(card.getByRole('button', { name: 'Use this account' })).toHaveCount(0);
  await expect(count).toHaveText(String(before - 1));
  await expect(page.locator('#rvCount')).toHaveText(new RegExp(`^${before - 1} items? needs? a person|^Nothing is waiting`));
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - y)).toBeLessThan(80);

  // the decision is listed with who made it, and the trail shows it as its own step
  await page.getByText(/^Decided, newest first/).click();
  await expect(page.locator('.rdecided tbody tr').first()).toContainText('Riley E2E');
  await card.getByRole('button', { name: 'Open the trail' }).click();
  await expect(page.getByRole('tab', { name: 'Lead stream' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Decided by a person', { exact: true })).toBeVisible();
  await expect(page.getByText('Chosen by a person · high confidence')).toBeVisible();

  expect(problems).toEqual([]);

  // the name is remembered for the next visit, and Outbound uses the same one (a reload cuts the live stream, which is expected)
  await page.reload();
  await page.getByRole('tab', { name: /Needs a person/ }).click();
  await expect(page.getByLabel('Deciding as')).toHaveValue('Riley E2E');
  await page.getByRole('tab', { name: 'Outbound' }).click();
  await expect(page.locator('#outboundBody').getByLabel('Deciding as')).toHaveValue('Riley E2E');
});
