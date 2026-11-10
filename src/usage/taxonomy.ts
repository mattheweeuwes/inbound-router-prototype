// The feature taxonomy: which PostHog event name is use of which feature, and what a lead can show that points at a feature.
// This is the one place both mappings live. The adapter reads EVENT_FEATURE, the fixture generator writes events from it, a test
// checks it against fixtures/usage/features.json, and the reverse ETL derives its per-feature HubSpot properties from FEATURE_KEYS.
// An event name that is not here is stored as unmapped and counted. FEATURE_CUES is read by src/interest, which tags a lead with
// the features it showed interest in (decision 30).
import type { Source } from '../schema';

/** Features whose use arrives as PostHog events. */
export const FEATURE_KEYS = ['signal_search', 'signal_watch', 'api', 'mcp', 'network_benchmarking', 'quality_preview'] as const;
/** Features that are in preview with no launch date: no event name maps to them, so they have no usage, only interest. */
export const PREVIEW_FEATURE_KEYS = ['signal_ask'] as const;
export const ALL_FEATURE_KEYS = [...FEATURE_KEYS, ...PREVIEW_FEATURE_KEYS] as const;

/** A feature with usage events. */
export type UsageFeature = typeof FEATURE_KEYS[number];
/** Any feature in the taxonomy, launched or not. */
export type Feature = typeof ALL_FEATURE_KEYS[number];

/** PostHog event name to the feature it is use of. More than one name may map to one feature. */
export const EVENT_FEATURE: Readonly<Record<string, UsageFeature>> = {
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
export const featureOf = (eventName: string): UsageFeature | null =>
  Object.hasOwn(EVENT_FEATURE, eventName) ? EVENT_FEATURE[eventName] : null;

/** The event name a feature is normally sent under: the first name in the table that maps to it. */
export const primaryEvent = (feature: UsageFeature): string =>
  Object.keys(EVENT_FEATURE).find(name => EVENT_FEATURE[name] === feature) as string;

/** Any feature in the taxonomy. */
export const isFeature = (v: string): v is Feature => (ALL_FEATURE_KEYS as readonly string[]).includes(v);
/** A feature that has usage events. */
export const isUsageFeature = (v: string): v is UsageFeature => (FEATURE_KEYS as readonly string[]).includes(v);

// ---- what a lead can show --------------------------------------------------------------------------------------------

/** A door a lead can come in through as a cue, optionally narrowed by the product an API key was made for. */
export interface DoorCue { source: Source; product?: string }

export interface FeatureCues {
  /** Words or phrases in the lead's message. Matched whole-word, any case, so "API" does not match inside "rapid". */
  aliases: readonly string[];
  /** Fragments of a page path an account-level web visit hit. Matched as substrings of the lowercased path with a trailing slash. */
  paths: readonly string[];
  /** Doors (and, for an API key, the product it was made for) that are themselves a request for the feature. */
  doors: readonly DoorCue[];
  /** HubSpot form ids of the gated guides that are about the feature. */
  guides: readonly string[];
}

/**
 * What each feature looks like from an inbound lead. A cue is a claim about interest and nothing more: it never changes a
 * lead's tier or route. Two choices are on purpose:
 * - the benefits playbook (gd_cost_intelligence) is about comparing networks for self-funded employers, so it points at
 *   Network benchmarking;
 * - the data-quality guide (gd_data_quality) is about the quality of price data, not the provider quality add-on, so it points
 *   at no feature.
 * An alias is a name or a phrase that names the feature, not a topic: "benchmarks" alone is in many messages that are not about
 * the feature, "network benchmarking" is not.
 */
export const FEATURE_CUES: Readonly<Record<Feature, FeatureCues>> = {
  signal_search: { aliases: ['signal search'], paths: ['/products/signal/'], doors: [], guides: [] },
  signal_watch: { aliases: ['signal watch', 'watch alerts'], paths: ['/products/signal-watch/', '/blog/signal-watch'], doors: [], guides: [] },
  api: { aliases: ['api'], paths: ['/products/api/'], doors: [{ source: 'api_key', product: 'api' }], guides: [] },
  mcp: { aliases: ['mcp', 'model context protocol'], paths: ['/products/mcp/'], doors: [{ source: 'api_key', product: 'mcp' }], guides: [] },
  network_benchmarking: {
    aliases: ['network benchmarking', 'network benchmark', 'network benchmarks'], paths: ['/products/network-benchmarking/'], doors: [], guides: ['gd_cost_intelligence'],
  },
  quality_preview: { aliases: ['quality data preview', 'provider quality', 'quality preview'], paths: ['/products/provider-quality/'], doors: [], guides: [] },
  signal_ask: { aliases: ['signal ask'], paths: ['/products/signal-ask/'], doors: [{ source: 'signal_ask_waitlist' }], guides: [] },
};
