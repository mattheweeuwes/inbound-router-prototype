// The PostHog adapter: maps PostHog's event shape (event, distinct_id, timestamp, uuid, and properties that carry the company
// group) onto the fields usage_events stores. Pure: no database, no account lookup (src/usage/ingest.ts does both).
//
// A batch is accepted as PostHog sends it: a bare array of events, a capture body { batch: [...] }, or one event object.
// An event that cannot be used is reported in `rejected` with its position and the reason, never skipped without a trace.
import { contactKey, normalizeEmail } from '../normalize';
import { PayloadError, sha } from '../sources/common';
import { featureOf, type Feature } from './taxonomy';

/** One event ready to store, before its company group is resolved to an account key. */
export interface AdaptedEvent {
  eventId: string;
  eventName: string;
  /** null when the event name is not in the taxonomy */
  feature: Feature | null;
  /** the company group key as PostHog sent it (properties.$groups.company, else $group_0) */
  groupKey: string | null;
  /** the router's contact key when distinct_id is an email address */
  contactKey: string | null;
  /** UTC ISO with milliseconds, the only form the database holds */
  occurredAt: string;
  synthetic: boolean;
}

export interface RejectedEvent { index: number; reason: string }
export interface AdaptedBatch { events: AdaptedEvent[]; rejected: RejectedEvent[] }

/** The most events one request may carry; a larger export is sent in several requests. */
export const MAX_BATCH = 1000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The events in a request body, whichever of PostHog's three shapes it has. */
function eventsOf(payload: unknown): { list: unknown[]; synthetic: boolean } {
  if (Array.isArray(payload)) return { list: payload, synthetic: false };
  if (!isObj(payload)) throw new PayloadError('usage payload: expected a JSON object or array of PostHog events');
  const synthetic = payload.synthetic === true;
  if (Array.isArray(payload.batch)) return { list: payload.batch, synthetic };
  if (typeof payload.event === 'string') return { list: [payload], synthetic };
  throw new PayloadError('usage payload: expected { batch: [...] }, an array of events, or one event with an "event" name');
}

/** properties.$groups.company, else properties.$group_0 (PostHog's positional alias for the first group type). */
function groupOf(props: Obj): string | null {
  return text(isObj(props.$groups) ? props.$groups.company : null) ?? text(props.$group_0);
}

function adaptOne(raw: unknown, batchSynthetic: boolean): AdaptedEvent | string {
  if (!isObj(raw)) return 'not a JSON object';
  const eventName = text(raw.event);
  if (!eventName) return 'event is required';
  const stamp = text(raw.timestamp);
  if (!stamp || Number.isNaN(Date.parse(stamp))) return 'timestamp is required and must be an ISO time';
  const occurredAt = new Date(stamp).toISOString();
  const props = isObj(raw.properties) ? raw.properties : {};
  const distinctId = text(raw.distinct_id);
  // PostHog sends a uuid with every stored event. One that arrives without is keyed on what identifies it, never on the server's clock.
  const eventId = text(raw.uuid) ?? sha('posthog', eventName, distinctId, occurredAt);
  return {
    eventId, eventName, feature: featureOf(eventName), groupKey: groupOf(props),
    contactKey: contactKey(normalizeEmail(distinctId)), occurredAt, synthetic: batchSynthetic || props.synthetic === true,
  };
}

/** Maps a request body onto stored events. Throws PayloadError for a body that is not a batch or is over MAX_BATCH. */
export function adaptBatch(payload: unknown): AdaptedBatch {
  const { list, synthetic } = eventsOf(payload);
  if (list.length > MAX_BATCH) throw new PayloadError(`usage payload: ${list.length} events in one request, the limit is ${MAX_BATCH}`);
  const out: AdaptedBatch = { events: [], rejected: [] };
  list.forEach((raw, index) => {
    const one = adaptOne(raw, synthetic);
    if (typeof one === 'string') out.rejected.push({ index, reason: one });
    else out.events.push(one);
  });
  return out;
}
