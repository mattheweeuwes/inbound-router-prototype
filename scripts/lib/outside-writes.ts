// Which scripts may reach a CRM or a messaging app, and the checks that keep the rest from doing it.
// The local .env can hold a live HubSpot key; a script that builds its context from defaults inherits it.

/** Spread into createCtx() by any script that runs synthetic data through the real pipeline but must never write outside this machine. */
export const NO_OUTSIDE_WRITES = { hubspotLive: false, hubspotToken: null } as const;

/** Scripts allowed to build a context that follows .env, so they can write to HubSpot when it is configured. Every other script spreads NO_OUTSIDE_WRITES. */
export const MAY_WRITE_CRM = ['replay.ts', 'reverse-etl.ts'] as const;

/** CI counts as set when the variable has any value other than empty, "0" or "false" (GitHub Actions sets CI=true). */
export function inCi(env: Record<string, string | undefined>): boolean {
  const v = env.CI?.trim().toLowerCase();
  return !!v && v !== '0' && v !== 'false';
}

/** The reason to refuse a run that would write to a live CRM from CI, or null when it may go ahead. */
export function refuseLiveCrmInCi(env: Record<string, string | undefined>, hubspotLive: boolean): string | null {
  return inCi(env) && hubspotLive ? 'Refusing to run: CI is set and HubSpot is LIVE. CI never writes to a CRM; set HUBSPOT_LIVE=0.' : null;
}
