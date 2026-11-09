// web_intent: Clay-style account-level web intent. No person.
import { base, eventKey, isoOr, needObject, needString, str, type Adapter } from './common';

export const webIntent: Adapter = (payload, nowIso) => {
  const p = needObject(payload, 'web_intent payload');
  const domain = needString(p.domain, 'domain').toLowerCase();
  const visits: any[] = Array.isArray(p.visits) ? p.visits : [];
  const last = visits.map(v => v?.at).filter(Boolean).sort().pop();
  const at = isoOr(last, nowIso);
  const ev = base('web_intent', eventKey(last, p, 'web_intent', domain, visits.length), at, p);
  ev.company = str(p.company);
  ev.context = {
    domain,
    visits,
    visitors: typeof p.visitors === 'number' ? p.visitors : null,
    windowDays: typeof p.window_days === 'number' ? p.window_days : null,
    paths: [...new Set(visits.map(v => v?.path).filter(Boolean))],
  };
  return ev;
};
