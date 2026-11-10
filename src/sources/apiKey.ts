// api_key: API / MCP developer key created.
import { splitName } from '../normalize';
import { base, eventKey, isoOr, needObject, needString, referralContext, str, type Adapter } from './common';

export const apiKey: Adapter = (payload, nowIso) => {
  const p = needObject(payload, 'api_key payload');
  const d = needObject(p.developer, 'developer');
  const email = needString(d.email, 'developer.email');
  const at = isoOr(p.created_at, nowIso);
  const ev = base('api_key', eventKey(p.created_at, p, 'api_key', p.product, email.toLowerCase()), at, p);
  const sp = splitName(str(d.name));
  ev.email = email; ev.firstName = sp.first; ev.lastName = sp.last;
  ev.title = str(d.title); ev.company = str(d.company); ev.state = str(d.state);
  ev.message = str(p.message);
  ev.context = { product: p.product ?? null, ...referralContext(d, p) };
  return ev;
};
