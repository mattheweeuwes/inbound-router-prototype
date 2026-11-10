// The feature taxonomy: which PostHog event name is use of which feature. This is the one place the mapping lives. The adapter reads
// it, the fixture generator writes events from it, a test checks it against fixtures/usage/features.json, and the reverse ETL
// derives its per-feature HubSpot properties from FEATURE_KEYS. An event name that is not here is stored as unmapped and counted.

export const FEATURE_KEYS = ['signal_search', 'signal_watch', 'api', 'mcp', 'network_benchmarking', 'quality_preview'] as const;
export type Feature = typeof FEATURE_KEYS[number];

/** PostHog event name to the feature it is use of. More than one name may map to one feature. */
export const EVENT_FEATURE: Readonly<Record<string, Feature>> = {
  signal_search_run: 'signal_search',
  // the sample sign-up door's PostHog payload (src/sources/app.ts) calls a search just "search"
  search: 'signal_search',
  watch_alert_created: 'signal_watch',
  api_call: 'api',
  mcp_tool_call: 'mcp',
  benchmark_viewed: 'network_benchmarking',
  quality_preview_viewed: 'quality_preview',
};

/** The feature an event name is use of, or null when the taxonomy does not know the name. */
export const featureOf = (eventName: string): Feature | null =>
  Object.hasOwn(EVENT_FEATURE, eventName) ? EVENT_FEATURE[eventName] : null;

/** The event name a feature is normally sent under: the first name in the table that maps to it. */
export const primaryEvent = (feature: Feature): string =>
  Object.keys(EVENT_FEATURE).find(name => EVENT_FEATURE[name] === feature) as string;

export const isFeature = (v: string): v is Feature => (FEATURE_KEYS as readonly string[]).includes(v);
