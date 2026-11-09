// guide_download and signal_ask_waitlist: HubSpot-form-like payloads.
import { base, eventKey, isoOr, needObject, needString, str, utmFrom, type Adapter } from './common';
import type { LeadEvent, Source } from '../schema';

function formAdapter(source: Source): Adapter {
  return (payload, nowIso): LeadEvent => {
    const p = needObject(payload, `${source} payload`);
    const f = needObject(p.fields, 'fields');
    const email = needString(f.email, 'fields.email');
    const at = isoOr(p.submitted_at, nowIso);
    const ev = base(source, eventKey(p.submitted_at, p, source, p.form_id, email.toLowerCase()), at, p);
    ev.email = email;
    ev.firstName = str(f.firstname);
    ev.lastName = str(f.lastname);
    ev.title = str(f.jobtitle);
    ev.company = str(f.company);
    ev.state = str(f.state);
    ev.message = str(f.message) ?? str(p.message);
    ev.utm = utmFrom(p.utm);
    ev.landingPage = str(p.page_url);
    ev.referrer = str(p.referrer);
    ev.context = { formId: p.form_id ?? null, guide: p.guide ?? null };
    return ev;
  };
}

export const guideDownload = formAdapter('guide_download');
export const signalAskWaitlist = formAdapter('signal_ask_waitlist');
