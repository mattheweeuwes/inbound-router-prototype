// The time-to-route budget for the replay in CI: a pure comparison, tested in test/ttr-budget.test.ts.
// A budget that cannot be read, or a run that routed nothing, is a failure. It never passes by being unmeasurable.

export interface TtrBudgetResult { budgetMs: number; p90Ms: number | null; pass: boolean; line: string }

/** Parse TTR_P90_BUDGET_MS. Only a plain positive number is a budget; anything else throws (a typo must not switch the check off). */
export function parseBudget(raw: string): number {
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`TTR_P90_BUDGET_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}`);
  const ms = Number(text);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`TTR_P90_BUDGET_MS must be greater than zero, got ${JSON.stringify(raw)}`);
  return ms;
}

/** p90 <= budget passes (equal passes). A null p90 means nothing was routed, so there is nothing to be within budget: fail. */
export function checkTtrBudget(p90Ms: number | null, budgetMs: number): TtrBudgetResult {
  if (!(typeof budgetMs === 'number' && Number.isFinite(budgetMs) && budgetMs > 0)) throw new Error(`budget must be a positive number of milliseconds, got ${String(budgetMs)}`);
  const measured = typeof p90Ms === 'number' && Number.isFinite(p90Ms);
  const pass = measured && p90Ms! <= budgetMs;
  const line = measured
    ? `time-to-route budget: p90 ${p90Ms}ms ${pass ? '<=' : '>'} ${budgetMs}ms ${pass ? 'PASS' : 'FAIL'}`
    : `time-to-route budget: p90 n/a (no lead was routed) against ${budgetMs}ms FAIL`;
  return { budgetMs, p90Ms: measured ? p90Ms : null, pass, line };
}
