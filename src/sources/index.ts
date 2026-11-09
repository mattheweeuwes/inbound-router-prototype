import { SOURCES, type LeadEvent, type Source } from '../schema';
import { apiKey } from './apiKey';
import { sampleSignup } from './app';
import { calendly } from './calendly';
import type { Adapter } from './common';
import { eventScan } from './eventScan';
import { guideDownload, signalAskWaitlist } from './form';
import { marketplace } from './marketplace';
import { webIntent } from './webIntent';

export { PayloadError } from './common';
export { signCalendly, verifyCalendly } from './calendly';

/**
 * Doors that must carry a verified signature. A signed door whose key is missing or blank refuses every request (503): an unconfigured
 * door must never fall back to accepting unsigned traffic. Doors not listed here are unsigned by design. To make another door signed,
 * add it here and verify it in api/inbound.ts; the tests walk this table.
 */
export interface SignedDoor { setting: string; header: string; key(cfg: { calendlyKey: string | null }): string | null }
export const SIGNED_DOORS: Partial<Record<Source, SignedDoor>> = {
  calendly_demo: { setting: 'CALENDLY_SIGNING_KEY', header: 'calendly-webhook-signature', key: cfg => cfg.calendlyKey },
};

/** The usable signing key for a door, or null when the door is unsigned by design or its key is missing/blank. */
export function signingKey(source: Source, cfg: { calendlyKey: string | null }): string | null {
  const k = SIGNED_DOORS[source]?.key(cfg);
  return k && k.trim() ? k : null;
}

/** Signed doors that have no usable key: the settings an operator still has to provide. */
export function unkeyedSignedDoors(cfg: { calendlyKey: string | null }): { source: Source; setting: string }[] {
  return (Object.entries(SIGNED_DOORS) as [Source, SignedDoor][]).filter(([s]) => !signingKey(s, cfg)).map(([source, d]) => ({ source, setting: d.setting }));
}

/** The one startup warning line for unkeyed signed doors, or null when every signed door has its key. */
export function signedDoorWarning(cfg: { calendlyKey: string | null }): string | null {
  const missing = unkeyedSignedDoors(cfg);
  if (!missing.length) return null;
  return `WARNING: signed door${missing.length > 1 ? 's' : ''} without a signing key, answering 503 until set: ${missing.map(m => `${m.source} (${m.setting})`).join(', ')}`;
}

const ADAPTERS: Record<Source, Adapter> = {
  calendly_demo: calendly, guide_download: guideDownload, signal_ask_waitlist: signalAskWaitlist,
  sample_signup: sampleSignup, marketplace, api_key: apiKey, event_scan: eventScan, web_intent: webIntent,
};

export const isSource = (s: string | null): s is Source => !!s && (SOURCES as string[]).includes(s);

export function adapt(source: Source, payload: unknown, nowIso = new Date().toISOString()): LeadEvent {
  return ADAPTERS[source](payload, nowIso);
}
