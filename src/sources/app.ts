// sample_signup: Try Signal / sample dashboard (PostHog-like payload with usage events).
import { splitName } from '../normalize';
import { base, eventKey, isoOr, needObject, needString, str, utmFrom, type Adapter } from './common';

export const sampleSignup: Adapter = (payload, nowIso) => {
  const p = needObject(payload, 'sample_signup payload');
  const u = needObject(p.user, 'user');
  const email = needString(u.email, 'user.email');
  const at = isoOr(p.signed_up_at, nowIso);
  const ev = base('sample_signup', eventKey(p.signed_up_at, p, 'sample_signup', email.toLowerCase()), at, p);
  const sp = splitName(str(u.name));
  ev.email = email;
  ev.firstName = sp.first; ev.lastName = sp.last;
  ev.title = str(u.title); ev.company = str(u.company); ev.state = str(u.state);
  ev.message = str(p.message);
  ev.utm = utmFrom(p.utm);
  const usage: any[] = Array.isArray(p.usage) ? p.usage : [];
  ev.context = {
    usage,
    sessions: usage.filter(x => x?.event === 'session_start').length,
    searches: usage.filter(x => x?.event === 'search').length,
    markets: [...new Set(usage.map(x => x?.market).filter(Boolean))],
  };
  return ev;
};
