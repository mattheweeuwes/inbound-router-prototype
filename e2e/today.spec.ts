// The Today tab in the browser: where the team starts the morning. It is the second tab, shows the brief's eight sections and the
// accounts table with enterprise accounts first, and every row opens the tab that holds its detail. Runs after the other specs
// (alphabetical order), so the server already holds their leads; this one sends its own so it does not depend on them.
// CommonSpirit Health is in the test registry, so the lead is an enterprise account whatever registry the server picked.
import { expect, test, type APIRequestContext, type ConsoleMessage, type Page } from '@playwright/test';

/** Any console error, failed request or HTTP 4xx/5xx fails the test, as in the other specs. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') problems.push(`console error: ${m.text()} (${m.location().url})`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });
  return problems;
}

const SECTIONS = ['Needs a person now', 'Enterprise', 'Referrals', 'List uploads', 'Expansion signals', 'Outbound', 'Feature interest this week', 'Health'];
const MESSAGE = 'We want Network Benchmarking ahead of our UnitedHealthcare renewal in Q1. Budget is approved for 2027.';

/** An enterprise lead that names a feature, through the cockpit's own demo route, finished before it returns. */
async function sendEnterpriseLead(request: APIRequestContext) {
  const res = await request.post('/api/demo/submit', {
    data: { source: 'calendly_demo', email: 'mgarcia.today.e2e@commonspirit.org', name: 'Maya Garcia-E2E', title: 'SVP, Managed Care', company: 'CommonSpirit Health', state: 'IL', message: MESSAGE, wait: true },
  });
  expect(res.ok()).toBe(true);
}

test('Today is the second tab, shows the brief and the accounts, and each row opens the tab that holds it', async ({ page, request }) => {
  const problems = watch(page);
  await sendEnterpriseLead(request);
  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();

  const tabs = page.getByRole('tab');
  await expect(tabs.nth(0)).toHaveText('Overview');
  await expect(tabs.nth(1)).toHaveText('Today');
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  // every section of the brief is on the page, each with its one-line answer
  for (const title of SECTIONS) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const enterprise = page.locator('section[data-section="enterprise"]');
  await expect(enterprise).toContainText('CommonSpirit Health');
  await expect(enterprise).toContainText('hospitals');

  // the accounts table puts enterprise accounts first, and CommonSpirit is one of them
  const rows = page.locator('.td-arow');
  await expect(rows.first().locator('.td-ent')).toHaveText('enterprise');
  await expect(rows.filter({ hasText: 'CommonSpirit Health' }).first().locator('.td-ent')).toBeVisible();
  const flags = await rows.evaluateAll(els => els.map(e => e.classList.contains('is-enterprise')));
  expect(flags.indexOf(false) === -1 || flags.lastIndexOf(true) < flags.indexOf(false), 'enterprise accounts come before every other').toBe(true);

  // an enterprise row opens the lead in the Lead stream
  await enterprise.getByRole('button', { name: 'Open in Lead stream' }).first().click();
  await expect(page.getByRole('tab', { name: 'Lead stream' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#detail')).toContainText('CommonSpirit Health');

  // a feature-interest row opens the feature, with who asked for it
  await tabs.nth(1).click();
  const interest = page.locator('section[data-section="interest"]');
  await interest.locator('.td-item').filter({ hasText: 'Network benchmarking' }).getByRole('button', { name: 'Open in Feature to pipeline' }).click();
  await expect(page.getByRole('tab', { name: 'Feature to pipeline' })).toHaveAttribute('aria-selected', 'true');
  const asked = page.getByRole('region', { name: 'Who asked for Network benchmarking' });
  await expect(asked).toContainText('CommonSpirit Health');
  await expect(asked.locator('.fp-quote').first()).toContainText('Network Benchmarking ahead of our UnitedHealthcare renewal');

  expect(problems, problems.join('\n')).toEqual([]);
});

test('Today at 390 px has no sideways scroll, on the page or in its area', async ({ page, request }) => {
  const problems = watch(page);
  await sendEnterpriseLead(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();
  await page.getByRole('tab', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: 'Needs a person now', exact: true })).toBeVisible();
  await expect(page.locator('.td-arow').first()).toBeVisible();
  const fits = await page.evaluate(() => {
    const views = document.querySelector('.views') as HTMLElement;
    return { page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, area: views.scrollWidth <= views.clientWidth };
  });
  expect(fits).toEqual({ page: true, area: true });
  expect(problems, problems.join('\n')).toEqual([]);
});
