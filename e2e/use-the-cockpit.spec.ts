// Using the cockpit the way a seller, a marketer, customer success or a RevOps reviewer does: each test is one task, done from the
// page, start to finish. They run last (the file name sorts after the others), on the leads the earlier specs left plus the ones
// this file sends: two enterprise people, a referral from a customer, a seven-row conference list, and a customer asking about a
// feature. Nothing here sends anything outside the throwaway server.
import { expect, test, type APIRequestContext, type ConsoleMessage, type Page } from '@playwright/test';

/** Any console error, failed request or HTTP 4xx/5xx fails the test, as in the other specs. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') problems.push(`console error: ${m.text()} (${m.location().url})`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  // a reload or a new address cancels the reads in flight; that is the page leaving, not a failure
  page.on('requestfailed', r => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`); });
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`); });
  return problems;
}

interface Row {
  id: string; receivedAt: string; tier: string | null; list: string | null; enterprise: boolean; routeAction: string | null;
  person: { name: string } | null; referral: { kind: string; referrer: string } | null; org: { name: string | null; accountId: string | null };
}
const leadsOf = async (request: APIRequestContext) => ((await (await request.get('/api/leads?limit=1000')).json()) as { leads: Row[] }).leads;

const LIST = 'E2E Expo';
const SCANS: [string, string, string, string, string][] = [
  ['Avery', 'Stone', 'VP, Managed Care Contracting', 'Intermountain Health', 'intermountainhealthcare.org'],
  ['Blake', 'Reyes', 'Director, Payer Contracting', 'Intermountain Health', 'intermountainhealthcare.org'],
  ['Casey', 'Nolan', 'Director of Network Strategy', 'CommonSpirit Health', 'commonspirit.org'],
  ['Devon', 'Park', 'Senior Analyst, Contracting', 'CommonSpirit Health', 'commonspirit.org'],
  ['Emery', 'Lowe', 'Manager, Provider Contracting', 'Intermountain Health', 'intermountainhealthcare.org'],
  ['Finley', 'Ortiz', 'Analyst', 'Intermountain Health', 'intermountainhealthcare.org'],
  ['Gray', 'Quill', 'Student', 'Intermountain Health', 'intermountainhealthcare.org'],
];

test.beforeAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL });
  const submit = async (data: Record<string, string>) => { const r = await api.post('/api/demo/submit', { data: { wait: true, ...data } }); expect(r.ok()).toBe(true); };
  // two enterprise people, the second the newest
  await submit({ source: 'calendly_demo', email: 'first.ent.use@commonspirit.org', name: 'Ines Okoro-Use', title: 'SVP, Managed Care', company: 'CommonSpirit Health', state: 'IL', message: 'We renegotiate with UnitedHealthcare in Q1.' });
  await submit({ source: 'calendly_demo', email: 'second.ent.use@commonspirit.org', name: 'Marcus Teller-Use', title: 'VP, Network Strategy', company: 'CommonSpirit Health', state: 'IL', message: 'We want a demo next week.' });
  // a referral from a customer
  await submit({ source: 'calendly_demo', email: 'ref.use@intermountainhealthcare.org', name: 'Rosa Lindgren-Use', title: 'Director, Payer Contracting', company: 'Intermountain Health', state: 'UT', message: 'We renegotiate in Q1. The contracting VP at Wrenfield Health recommended you.' });
  // a customer asking about a feature that has not launched
  await submit({ source: 'signal_ask_waitlist', email: 'asks.use@brindlewoodhealth.example', name: 'Marguerite Oyelaran-Use', title: 'Director, Provider Network', company: 'Brindlewood Mutual Health', state: 'OH', message: 'We use Signal weekly. Would Signal Ask cover our out-of-network exposure by market?' });
  // a conference list, scanned at once
  let n = 0;
  for (const [first, last, title, company, domain] of SCANS) {
    n++;
    const r = await api.post('/api/inbound?source=event_scan', {
      data: { synthetic: true, event: LIST, scanned_at: new Date(Date.UTC(2026, 10, 9, 15, n)).toISOString(), badge: { email: `${first}.${last}.use${n}@${domain}`.toLowerCase(), first, last, title, company, state: 'UT' }, notes: 'Stopped by the booth to ask about rates.' },
    });
    expect(r.status()).toBeLessThan(300);
  }
  await expect.poll(async () => (await leadsOf(api)).filter(l => l.list === LIST && l.routeAction).length, { timeout: 20_000 }).toBe(SCANS.length);
  await api.dispose();
});

/** The count line above the list, which says how many of the leads the filters keep. */
const countLine = (page: Page) => page.locator('#listCount');
const rowsOf = (page: Page) => page.getByRole('listbox', { name: 'Leads' }).getByRole('option');

test('find today\'s enterprise leads and open the newest', async ({ page, request }) => {
  const problems = watch(page);
  const all = await leadsOf(request);
  const enterprise = all.filter(l => l.enterprise).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  expect(enterprise.length).toBeGreaterThanOrEqual(2);

  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();
  await page.getByRole('tab', { name: 'Lead stream' }).click();
  await expect(countLine(page)).toContainText(`${all.length} of ${all.length} leads`);

  // one click narrows to enterprise accounts, and the button says how many there are
  const toggle = page.getByRole('button', { name: /^Enterprise/ });
  await expect(toggle).toContainText(String(enterprise.length));
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(countLine(page)).toContainText(`${enterprise.length} of ${all.length} leads`);
  for (const row of await rowsOf(page).all()) await expect(row.locator('.rmark-ent')).toBeVisible();

  // the newest is first, and opening it shows its trail and puts it in the address
  const newest = enterprise[0];
  await rowsOf(page).first().click();
  await expect(page.locator('#detail .d-name')).toContainText(newest.person?.name.split(' ')[0] ?? '');
  await expect(page).toHaveURL(new RegExp(`lead=${newest.id}`));
  await expect(page).toHaveURL(/enterprise=1/);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('find who was referred by a customer, starting from the Overview', async ({ page, request }) => {
  const problems = watch(page);
  const all = await leadsOf(request);
  const byWren = all.filter(l => l.referral?.referrer === 'Wrenfield Health');
  expect(byWren.length).toBeGreaterThanOrEqual(1);

  await page.goto('/');
  await expect(page.getByText('Live API')).toBeVisible();
  // the Named referrals card ranks the referrers; the customer's row is a link to its leads
  const card = page.locator('article[data-card="referrals"]');
  await card.getByRole('link', { name: 'Wrenfield Health' }).click();
  await expect(page.getByRole('tab', { name: 'Lead stream' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#filterBar .sf-pill')).toContainText('Referred by Wrenfield Health');
  await expect(countLine(page)).toContainText(`${byWren.length} of ${all.length} leads`);
  await expect(rowsOf(page)).toHaveCount(byWren.length);
  // each row is marked a referral, and hovering says whose and that it is a customer
  await expect(rowsOf(page).first().locator('.rmark-ref')).toHaveAttribute('title', 'Referred by Wrenfield Health, a customer');
  await rowsOf(page).filter({ hasText: 'Rosa Lindgren-Use' }).click();
  await expect(page.locator('#detail')).toContainText('Rosa Lindgren-Use');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('open a list and find its tier B rows', async ({ page, request }) => {
  const problems = watch(page);
  const all = await leadsOf(request);
  const list = all.filter(l => l.list === LIST);
  const tierB = list.filter(l => l.tier === 'B');
  expect(tierB.length).toBeGreaterThanOrEqual(2);

  await page.goto('/#stream');
  await expect(countLine(page)).toContainText(`${all.length} of ${all.length} leads`);
  // in the default view the list is one row at the place of its newest row, with its size and its tier mix
  const group = page.getByRole('button', { name: new RegExp(`^${LIST}, ${list.length} rows: `) });
  await expect(group).toBeVisible();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(rowsOf(page).filter({ hasText: 'Gray Quill' })).toHaveCount(0);
  await expect(countLine(page)).toContainText('1 list folded');
  // it opens in place
  const before = await rowsOf(page).count();
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(rowsOf(page)).toHaveCount(before + list.length);
  await group.click();
  await expect(rowsOf(page)).toHaveCount(before);

  // choosing the list in the List filter shows its rows alone, and the option says how many
  const filter = page.getByRole('combobox', { name: 'List' });
  await expect(filter.locator(`option[value="${LIST}"]`)).toHaveText(`${LIST} (${list.length})`);
  await filter.selectOption(LIST);
  await expect(rowsOf(page)).toHaveCount(list.length);
  await expect(page.locator('.grow')).toHaveCount(0);
  await expect(countLine(page)).toContainText(`${list.length} of ${all.length} leads`);

  // Tier B keeps the B rows, and says how many there are
  const b = page.getByRole('button', { name: /^Tier B/ });
  await expect(b).toContainText(String(tierB.length));
  await b.click();
  await expect(rowsOf(page)).toHaveCount(tierB.length);
  for (const t of await page.locator('#leadList .cell-tier .tier').allTextContents()) expect(t).toBe('B');
  await expect(page).toHaveURL(/list=E2E(\+|%20)Expo/);
  await expect(page).toHaveURL(/tier=B/);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('an empty result says what is filtered and clears with one click', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/#stream?q=zzzz-no-such-lead&tier=A');
  await expect(page.getByText('No leads match.')).toBeVisible();
  await expect(page.locator('.list-empty')).toContainText('Tier A');
  await expect(page.locator('.list-empty')).toContainText('Search "zzzz-no-such-lead"');
  await page.locator('.list-empty').getByRole('button', { name: 'Clear filters' }).click();
  await expect(rowsOf(page).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await expect(page).toHaveURL(/#stream$/);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('search finds a list by its name, a lead by its rule and by who referred it', async ({ page, request }) => {
  const problems = watch(page);
  const all = await leadsOf(request);
  await page.goto('/#stream');
  const search = page.getByRole('searchbox', { name: 'Search leads' });
  await search.fill('e2e expo');
  await expect(countLine(page)).toContainText(`${all.filter(l => l.list === LIST).length} of ${all.length} leads`);
  await search.fill('wrenfield');
  await expect(countLine(page)).toContainText(`${all.filter(l => l.referral?.referrer === 'Wrenfield Health').length} of ${all.length} leads`);
  await search.fill('R10');
  await expect(countLine(page)).not.toContainText(`${all.length} of ${all.length}`);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('find the customers who asked for a feature and open the lead', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/#feature?f=signal_ask');
  await expect(page.getByText('Live API')).toBeVisible();
  const asked = page.getByRole('region', { name: 'Who asked for Signal Ask' });
  await expect(asked).toBeVisible();

  // the asked list is a table; customers only keeps the ones the CRM holds as customers, and the button says how many
  const rows = asked.locator('tbody .fp-arow');
  const all = await rows.count();
  expect(all).toBeGreaterThanOrEqual(1);
  const customers = asked.getByRole('button', { name: /^Customers only/ });
  await customers.click();
  await expect(customers).toHaveAttribute('aria-pressed', 'true');
  const kept = await rows.count();
  expect(kept).toBeGreaterThanOrEqual(1);
  for (const badge of await rows.locator('.badge').allTextContents()) expect(badge).toBe('customer');
  await expect(asked.locator('.fp-count')).toHaveText(`${kept} of ${all} asked`);
  await expect(page).toHaveURL(/customers=1/);

  // the quote opens on the row
  const row = rows.filter({ hasText: 'Brindlewood Mutual Health' }).first();
  await row.getByRole('button', { name: /Brindlewood Mutual Health/ }).click();
  await expect(asked.locator('.fp-quote').first()).toContainText('Signal Ask cover our out-of-network exposure');

  // and the row opens its lead in the Lead stream
  await row.getByRole('link', { name: 'Open lead' }).click();
  await expect(page.getByRole('tab', { name: 'Lead stream' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#detail .d-name')).toContainText('Marguerite Oyelaran-Use');
  await expect(page).toHaveURL(/#stream\?lead=/);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the features table sorts by a column, and the choice is in the address', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/#feature');
  const table = page.getByRole('table').filter({ hasText: 'Win rate with use' });
  const header = table.getByRole('columnheader', { name: /Deals around it/ });
  await header.getByRole('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  const deals = (await table.locator('tbody tr').evaluateAll(trs => trs.map(tr => Number(tr.querySelector('td:nth-child(3) .fp-big')?.textContent?.replace(/,/g, '')))));
  expect(deals).toEqual([...deals].sort((a, b) => b - a));
  await expect(page).toHaveURL(/sort=deals/);
  await header.getByRole('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('copy a link to a lead, open it in a new page and land on the same lead', async ({ page, context }) => {
  const problems = watch(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#stream');
  await expect(rowsOf(page).first()).toBeVisible();
  await rowsOf(page).nth(2).click();
  const name = await page.locator('#detail .d-name').innerText();
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.locator('#detail .copy-msg')).toHaveText('Link copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#stream\?lead=[0-9a-f-]+$/);

  const other = await context.newPage();
  const otherProblems = watch(other);
  await other.goto(link);
  await expect(other.locator('#detail .d-name')).toHaveText(name);
  await expect(other.getByRole('tab', { name: 'Lead stream' })).toHaveAttribute('aria-selected', 'true');
  await expect(other.locator('#leadList .row.is-selected')).toBeVisible();
  expect(problems.concat(otherProblems), problems.concat(otherProblems).join('\n')).toEqual([]);
});

test('reload on a filtered view and keep it, and the back button returns to the lead before', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/#stream');
  await expect(rowsOf(page).first()).toBeVisible();
  await page.getByRole('button', { name: /^Enterprise/ }).click();
  await page.getByRole('button', { name: 'Score', exact: true }).click();
  const line = await countLine(page).innerText();
  await rowsOf(page).nth(0).click();
  const first = await page.locator('#detail .d-name').innerText();
  await rowsOf(page).nth(1).click();
  const second = await page.locator('#detail .d-name').innerText();
  expect(second).not.toBe(first);

  await page.reload();
  await expect(page.getByRole('button', { name: /^Enterprise/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('columnheader', { name: /Score/ })).toHaveAttribute('aria-sort', 'descending');
  await expect(countLine(page)).toHaveText(line);
  await expect(page.locator('#detail .d-name')).toHaveText(second);

  await page.goBack();
  await expect(page.locator('#detail .d-name')).toHaveText(first);
  await expect(page.getByRole('button', { name: /^Enterprise/ })).toHaveAttribute('aria-pressed', 'true');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('Today: jump to the accounts, find the ones with no owner, sort them and open one\'s people', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/#today');
  await expect(page.getByRole('heading', { name: 'Needs a person now', exact: true })).toBeVisible();
  // the index lists every section with its count, and jumps
  const index = page.getByRole('navigation', { name: 'Sections on this page' });
  await expect(index.getByRole('button', { name: /^Enterprise/ })).toContainText(/\d/);
  await index.getByRole('button', { name: /^Accounts/ }).click();
  const table = page.locator('#tdAccounts');
  await expect(table.getByRole('heading', { name: 'Accounts' })).toBeInViewport();

  // No owner keeps the accounts nobody has, with the count on the button and in the line above the table
  const noOwner = table.getByRole('button', { name: /^No owner/ });
  const n = Number((await noOwner.innerText()).replace(/\D/g, ''));
  expect(n).toBeGreaterThan(0);
  await noOwner.click();
  await expect(table.locator('.ob-count')).toContainText(new RegExp(`^${n} of \\d+ accounts`));
  for (const owner of await table.locator('tbody td[data-label="Owner"]').allTextContents()) expect(owner).toBe('no owner');
  await expect(page).toHaveURL(/noowner=1/);

  // a column sorts, with its direction announced
  const people = table.getByRole('columnheader', { name: /People in/ });
  await people.getByRole('button').click();
  await expect(people).toHaveAttribute('aria-sort', 'descending');

  // the account opens its people in the Lead stream
  const link = table.locator('tbody .td-account').first();
  const accountName = await link.innerText();
  await link.click();
  await expect(page.getByRole('tab', { name: 'Lead stream' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#filterBar')).toContainText(`Account ${accountName}`);
  await expect(page).toHaveURL(/account=/);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('at 390 px the filters wrap and nothing scrolls the page sideways on the tabs that changed', async ({ page }) => {
  const problems = watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = () => page.evaluate(() => ({ page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, area: (() => { const v = document.querySelector('.views') as HTMLElement; return v.scrollWidth <= v.clientWidth; })() }));

  await page.goto('/#stream');
  await expect(page.getByText('Live API')).toBeVisible();
  await expect(rowsOf(page).first()).toBeVisible();
  // every control in the filter bar is inside the screen: they wrap instead of running off it
  const boxes = await page.locator('#filterBar > *').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { right: r.right, left: r.left, shown: r.width > 0 }; }));
  expect(boxes.length).toBeGreaterThan(5);
  for (const b of boxes.filter(x => x.shown)) { expect(b.left).toBeGreaterThanOrEqual(0); expect(b.right).toBeLessThanOrEqual(390.5); }
  expect(await fits()).toEqual({ page: true, area: true });
  // a lead opens as a sheet over the list, and goes back to it
  await rowsOf(page).first().click();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to the list' })).toBeVisible();
  expect(await fits()).toEqual({ page: true, area: true });
  await page.getByRole('button', { name: 'Back to the list' }).click();
  await expect(page.locator('#detail')).toBeHidden();

  for (const tab of ['today', 'outbound', 'feature']) {
    await page.goto(`/#${tab}`);
    await page.reload();
    await expect(page.getByText('Live API')).toBeVisible();
    await expect(page.locator(`#view-${tab === 'feature' ? 'feature-pipeline' : tab}`)).toBeVisible();
    await page.waitForTimeout(600);
    expect(await fits(), tab).toEqual({ page: true, area: true });
  }
  await page.goto('/#overview');
  await page.reload();
  await expect(page.locator('#overview .sec-index')).toBeVisible();
  expect((await fits()).page).toBe(true);
  expect(problems, problems.join('\n')).toEqual([]);
});
