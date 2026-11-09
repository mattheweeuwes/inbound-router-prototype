// event_scan: conference badge scan.
import { base, eventKey, isoOr, needObject, needString, str, type Adapter } from './common';

export const eventScan: Adapter = (payload, nowIso) => {
  const p = needObject(payload, 'event_scan payload');
  const b = needObject(p.badge, 'badge');
  const email = needString(b.email, 'badge.email');
  const at = isoOr(p.scanned_at, nowIso);
  const ev = base('event_scan', eventKey(p.scanned_at, p, 'event_scan', p.event, email.toLowerCase()), at, p);
  ev.email = email; ev.firstName = str(b.first); ev.lastName = str(b.last);
  ev.title = str(b.title); ev.company = str(b.company); ev.state = str(b.state);
  ev.message = str(p.notes);
  ev.context = { event: p.event ?? null, notes: p.notes ?? null };
  return ev;
};
