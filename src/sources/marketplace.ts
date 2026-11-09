// marketplace: Databricks / Snowflake / Arcadia listing inquiry.
import { splitName } from '../normalize';
import { base, eventKey, isoOr, needObject, needString, str, type Adapter } from './common';

export const marketplace: Adapter = (payload, nowIso) => {
  const p = needObject(payload, 'marketplace payload');
  const r = needObject(p.requester, 'requester');
  const email = needString(r.email, 'requester.email');
  const at = isoOr(p.received_at, nowIso);
  const ev = base('marketplace', eventKey(p.received_at, p, 'marketplace', p.marketplace, p.listing, email.toLowerCase()), at, p);
  const sp = splitName(str(r.name));
  ev.email = email; ev.firstName = sp.first; ev.lastName = sp.last;
  ev.title = str(r.title); ev.company = str(r.company); ev.state = str(r.state);
  ev.message = str(p.message);
  ev.context = { marketplace: p.marketplace ?? null, listing: p.listing ?? null };
  return ev;
};
