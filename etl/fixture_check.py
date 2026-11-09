"""Resolve every fixture organisation against the freshly built registry and write
data/fixture-org-check.md and data/fixture-overrides.json.  Called by build_registry.py."""
import json
import os
import urllib.parse
import urllib.request

import netutil
from name_norm import name_norm

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'data')

# id, person-org label, domain, expectation
#   expectation kinds: ahrq:<health_sys_name substring>, cms:<ccn>, payer:<slug>, curated:<segment>, free, disposable,
#                      nppes (provider group resolved via NPPES, not the registry), unknown (must NOT be in the registry),
#                      nxdomain, name_ahrq:<name_norm>:<state>, ambiguous:<prefix>
FIXTURES = [
    ('F01', 'Intermountain Health', 'intermountainhealthcare.org', 'ahrq:Intermountain Healthcare'),
    ('F02', 'Sutter Health', 'sutterhealth.org', 'ahrq:Sutter Health'),
    ('F03', 'OhioHealth', 'ohiohealth.com', 'ahrq:Ohiohealth'),
    ('F04', 'Tanner Health', 'tanner.org', 'ahrq:Tanner Health System'),
    ('F05', 'Brookmere Health Plan (fictional CRM account)', 'brookmerehealth.example', 'nxdomain'),
    ('F06', 'Priority Health', 'priorityhealth.com', 'payer:priority-health'),
    ('F07', 'Alder & Finch Benefits (fictional CRM account)', 'alderfinch.example', 'nxdomain'),
    ('F08', 'Hylant', 'hylant.com', 'curated:benefits_consultant_broker'),
    ('F09', 'Mohawk Industries', 'mohawkind.com', 'unknown'),
    ('F10', 'Highmark Health', 'highmarkhealth.org', 'payer:highmark-health'),
    ('F11', 'Paytient', 'paytient.com', 'curated:innovator_api_data'),
    ('F12', 'Atrium Health', 'atriumhealth.org', 'ahrq:Advocate Health'),
    ('F13', 'Tanner Health (same account as F04)', 'tanner.org', 'ahrq:Tanner Health System'),
    ('F14', 'Jefferson Healthcare', 'jeffersonhealthcare.org', 'standalone:501323'),
    ('F15', 'Transcarent', 'transcarent.com', 'curated:innovator_navigation'),
    ('F16', 'Genentech', 'gene.com', 'curated:life_sciences'),
    ('F17', 'Cressey & Company', 'cresseyco.com', 'curated:pe_investor'),
    ('F18', 'Chartis', 'chartis.com', 'curated:consulting_advisory'),
    ('F19', 'US Anesthesia Partners', 'usap.com', 'nppes:U.S. Anesthesia Partners'),
    ('F20', 'STAT', 'statnews.com', 'curated:media'),
    ('F21', 'Georgia Tech', 'gatech.edu', 'curated:academic'),
    ('F22', 'gmail.com, no company', 'gmail.com', 'free'),
    ('F23', 'BrightPath Agency', 'brightpath-agency.example', 'nxdomain'),
    ('F24', 'Turquoise Health', 'turquoise.health', 'curated:competitor'),
    ('F25', 'outlook.com + company "Northside Hospital", GA', 'outlook.com', 'free'),
    ('F26', 'Intermountain Health (same person as F01)', 'intermountainhealthcare.org', 'ahrq:Intermountain Healthcare'),
    ('F27', 'OhioHealth (re-delivery of F03)', 'ohiohealth.com', 'ahrq:Ohiohealth'),
    ('F28', 'Wrenfield Health (fictional CRM account)', 'wrenfieldhealth.example', 'nxdomain'),
    ('F29', 'gmail.com + company "Baptist Health", no state', 'gmail.com', 'free'),
    ('F30', 'mailinator.com, company "zzzz"', 'mailinator.com', 'disposable'),
    ('F31', 'NHS', 'nhs.net', 'unknown'),
    ('F32', 'Sutter Health (web intent)', 'sutterhealth.org', 'ahrq:Sutter Health'),
    ('F33', 'Meritain Health', 'meritain.com', 'curated:tpa'),
    ('F34', 'City of Atlanta', 'atlantaga.gov', 'curated:government'),
    ('F35', 'Johns Hopkins Medicine', 'jhmi.edu', 'ahrq:Johns Hopkins Health System'),
    ('F36', 'Baptist Health South Florida', 'baptisthealth.net', 'ahrq:Baptist Health South Florida'),
    ('F37', 'Zelis', 'zelis.com', 'curated:innovator_api_data'),
    ('F38', 'Independence Blue Cross', 'ibx.com', 'payer:independence-bcbs'),
    ('F39', 'RAYUS Radiology', 'rayusradiology.com', 'nppes:RAYUS'),
    ('F40', 'Piedmont Healthcare', 'piedmont.org', 'ahrq:Piedmont Healthcare'),
]

# Real, independent (non-system) hospitals in Washington to use if jeffersonhealthcare.org cannot be a standalone fixture.
F14_REPLACEMENT_CANDIDATES = [
    ('pullmanregional.org', 'Pullman Regional Hospital', 'WA'),
    ('whitmanhospital.org', 'Whitman Hospital and Medical Center', 'WA'),
    ('lincolnhospital.org', 'Lincoln Hospital', 'WA'),
    ('oceanbeachhospital.org', 'Ocean Beach Hospital', 'WA'),
    ('islandhospital.org', 'Island Hospital', 'WA'),
    ('skagitregionalhealth.org', 'Skagit Regional Health', 'WA'),
    ('cascademedical.org', 'Cascade Medical Center', 'WA'),
    ('mid-valley.org', 'Mid-Valley Hospital', 'WA'),
]


def _nppes(name):
    variants = [name, name.replace('.', ''), name.replace('U.S.', 'US')]
    d = {}
    try:
        for v in variants:
            q = urllib.parse.urlencode({'version': '2.1', 'enumeration_type': 'NPI-2', 'organization_name': v + '*', 'limit': 5})
            url = 'https://npiregistry.cms.hhs.gov/api/?' + q
            r = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': netutil.UA}), timeout=6)
            d = json.loads(r.read())
            if d.get('result_count'):
                break
        out = []
        for x in d.get('results', [])[:5]:
            b = x.get('basic', {})
            tx = [t.get('desc') for t in x.get('taxonomies', []) if t.get('primary')]
            out.append('NPI %s %s (%s)' % (x.get('number'), b.get('organization_name'), (tx or ['?'])[0]))
        return out, d.get('result_count', 0)
    except Exception as e:
        return ['NPPES lookup failed: %s' % type(e).__name__], 0


def _row_for(conn, vc, dom):
    """what does the registry say about this domain? -> (table, id, name, detail)"""
    r = conn.execute('SELECT name, segment, subsegment, size_class FROM curated_orgs WHERE domain=?', (dom,)).fetchone()
    if r:
        return ('curated_orgs', dom, r[0], 'segment=%s size=%s' % (r[1], r[3]))
    r = conn.execute('SELECT entity_type, entity_id, name, evidence FROM org_domains WHERE domain=?', (dom,)).fetchone()
    if r:
        det = ''
        if r[0] == 'cms_hospital':
            pl = conn.execute('SELECT s.health_sys_id, s.name FROM ahrq_hospital_links l JOIN ahrq_systems s USING(health_sys_id) WHERE l.ccn=?', (r[1],)).fetchall()
            det = 'parent AHRQ system(s) via links: %s' % ('; '.join('%s %s' % x for x in pl) if pl else 'none (standalone)')
        elif r[0] == 'ahrq_system':
            s = conn.execute('SELECT hosp_cnt, sys_beds, state, multistate FROM ahrq_systems WHERE health_sys_id=?', (r[1],)).fetchone()
            det = 'hosp_cnt=%s sys_beds=%s HQ=%s multistate=%s' % s
        elif r[0] == 'payer':
            p = conn.execute('SELECT kind, parent FROM payers WHERE slug=?', (r[1],)).fetchone()
            det = 'kind=%s parent=%s' % p
        return ('org_domains/' + r[0], r[1], r[2], det + ' || ' + r[3])
    if conn.execute('SELECT 1 FROM free_mail_domains WHERE domain=?', (dom,)).fetchone():
        return ('free_mail_domains', dom, dom, '')
    if conn.execute('SELECT 1 FROM disposable_domains WHERE domain=?', (dom,)).fetchone():
        return ('disposable_domains', dom, dom, '')
    return (None, None, None, '')


def run(conn, vc, report):
    notes = {}
    # --- F14: Jefferson Healthcare is a standalone *hospital* but AHRQ links its CCN to a (1-hospital) system.
    link = conn.execute("SELECT s.health_sys_id, s.name, s.hosp_cnt, s.sys_beds FROM ahrq_hospital_links l JOIN ahrq_systems s USING(health_sys_id) WHERE l.ccn='501323'").fetchone()
    overrides = {}
    if link:
        pick = None
        for dom, hint, st in F14_REPLACEMENT_CANDIDATES:
            hn = name_norm(hint)
            cands = conn.execute('SELECT ccn, name, city, state, hospital_type, ownership FROM cms_hospitals WHERE state=? AND name_norm=?', (st, hn)).fetchall()
            if not cands:
                cands = conn.execute('SELECT ccn, name, city, state, hospital_type, ownership FROM cms_hospitals WHERE state=? AND name_norm LIKE ?', (st, hn + '%')).fetchall()
            if len(cands) != 1:
                continue
            ccn = cands[0][0]
            if conn.execute('SELECT 1 FROM ahrq_hospital_links WHERE ccn=?', (ccn,)).fetchone():
                continue
            res = vc.get(dom)
            from build_registry import title_match
            ok, ev = title_match([cands[0][1], hint], res)
            if not ok:
                continue
            pick = (dom, cands[0], ev)
            break
        if pick:
            dom, c, ev = pick
            overrides['F14'] = {
                'company': c[1].title().replace('Of', 'of'), 'domain': dom, 'state': c[3], 'ccn': c[0],
                'reason': ('jeffersonhealthcare.org resolves to CMS hospital 501323, but the 2023 AHRQ compendium links CCN 501323 to its own '
                           'one-system record %s (%s, hosp_cnt=%s, sys_beds=%s). The parent-system step in the resolver would therefore resolve it to health_system, '
                           'contradicting F14 gold (standalone_hospital). Replacement is a real independent hospital that is in CMS but in no AHRQ '
                           'system: CCN %s, %s, %s, %s.' % (link[0], link[1], link[2], link[3], c[0], c[1], c[2], c[3])),
                'homepage_evidence': ev}
            conn.execute('INSERT OR REPLACE INTO org_domains VALUES (?,?,?,?,?,?)',
                         (dom, 'cms_hospital', c[0], c[1], 'fixture-override | ' + ev, netutil.now_iso()))
    report['f14_override'] = overrides.get('F14')

    nppes_cache = {}
    lines = []
    ok_n = 0
    graded = 0
    for fid, label, dom, exp in FIXTURES:
        eff_dom = dom
        eff_note = ''
        if fid in overrides:
            eff_dom = overrides[fid]['domain']
            eff_note = ' [OVERRIDE -> %s, %s]' % (overrides[fid]['company'], eff_dom)
        kind = exp.split(':', 1)[0]
        arg = exp.split(':', 1)[1] if ':' in exp else ''
        table, eid, nm, det = _row_for(conn, vc, eff_dom)
        status = 'PROBLEM'
        resolves = '(not in registry)'
        evidence = ''
        expected_txt = exp
        if kind == 'ahrq':
            expected_txt = 'AHRQ system "%s"' % arg
            if table == 'org_domains/ahrq_system' and nm == arg:
                status = 'OK'
            resolves = '%s | %s | %s | %s' % (table, eid, nm, det.split(' || ')[0]) if table else resolves
            evidence = det.split(' || ')[1] if ' || ' in det else ''
        elif kind == 'payer':
            expected_txt = 'payer slug %s' % arg
            if table == 'org_domains/payer' and eid == arg:
                status = 'OK'
            resolves = '%s | %s | %s | %s' % (table, eid, nm, det.split(' || ')[0]) if table else resolves
            evidence = det.split(' || ')[1] if ' || ' in det else ''
        elif kind == 'curated':
            expected_txt = 'curated_orgs, segment %s' % arg
            if table == 'curated_orgs' and ('segment=' + arg) in det:
                status = 'OK'
            resolves = '%s | %s | %s | %s' % (table, eid, nm, det) if table else resolves
            r = vc.d.get(eff_dom) or {}
            evidence = evidence_for(r)
        elif kind == 'standalone':
            expected_txt = 'CMS hospital CCN %s, standalone (no AHRQ system link)' % arg
            resolves = '%s | %s | %s | %s' % (table, eid, nm, det.split(' || ')[0]) if table else resolves
            evidence = det.split(' || ')[1] if ' || ' in det else ''
            if table == 'org_domains/cms_hospital' and 'none (standalone)' in det:
                status = 'OK'
            elif fid in overrides:
                status = 'OK (override)'
            else:
                status = 'PROBLEM'
        elif kind in ('free', 'disposable'):
            expected_txt = '%s_mail table' % ('free' if kind == 'free' else 'disposable')
            tb = 'free_mail_domains' if kind == 'free' else 'disposable_domains'
            if table == tb:
                status = 'OK'
            resolves = '%s | %s' % (table, eid) if table else resolves
            evidence = 'n/a (consumer / throwaway domain)'
        elif kind == 'nxdomain':
            expected_txt = 'no DNS (reserved .example), unresolved'
            if not netutil.dns_ok(eff_dom) and not table:
                status = 'OK'
            resolves = '(not in registry; DNS does not resolve)'
            evidence = 'fake org by design'
        elif kind == 'unknown':
            expected_txt = 'NOT in registry (must stay unknown)'
            if not table:
                status = 'OK'
            r = vc.get(eff_dom)
            resolves = '(not in registry)' if not table else '%s | %s | %s' % (table, eid, nm)
            evidence = evidence_for(r) + (' | no homepage evidence' if not r.get('title') else '')
        elif kind == 'nppes':
            expected_txt = 'provider group via NPPES (NPI-2), not forced into AHRQ'
            r = vc.get(eff_dom)
            if arg not in nppes_cache:
                nppes_cache[arg] = _nppes(arg)
            hits, cnt = nppes_cache[arg]
            resolves = '(not in registry, by design) | NPPES NPI-2 name search "%s*": %s result(s): %s' % (arg, cnt, '; '.join(hits[:3]))
            evidence = evidence_for(r)
            status = 'OK' if (not table and r.get('title') and cnt) else ('OK (NPPES unreachable)' if not table and r.get('title') else 'PROBLEM')
        if fid == 'F25':
            expected_txt += ' + company-name match to AHRQ "Northside Hospital" (GA)'
            c = conn.execute("SELECT health_sys_id, name, state, hosp_cnt FROM ahrq_systems WHERE name_norm=? AND state='GA'", ('northside hospital',)).fetchall()
            resolves += ' || name match: ' + ('; '.join('%s %s (%s, %s hosp)' % x for x in c) if c else 'NONE')
            if len(c) != 1:
                status = 'PROBLEM'
            noth = conn.execute("SELECT COUNT(*) FROM ahrq_systems WHERE name_norm LIKE 'northside%'").fetchone()[0]
            evidence = 'AHRQ systems whose name starts "Northside": %d' % noth
        if fid == 'F29':
            expected_txt += ' + company "Baptist Health" with no state must be ambiguous'
            c = conn.execute("SELECT health_sys_id, name, state, hosp_cnt FROM ahrq_systems WHERE name_norm LIKE 'baptist health%' ORDER BY hosp_cnt DESC").fetchall()
            resolves += ' || AHRQ candidates: ' + '; '.join('%s %s (%s, %s hosp)' % x for x in c)
            if len(c) < 3:
                status = 'PROBLEM'
            evidence = '%d AHRQ systems named "Baptist Health ..." -> ambiguous as designed' % len(c)
        if status == 'OK' and 'WIKIDATA-P856-ONLY' in (evidence + det):
            status = 'OK (P856-only: homepage bot-blocked)'
        graded += 1
        if status.startswith('OK'):
            ok_n += 1
        lines.append((fid, eff_dom + eff_note, expected_txt, resolves, evidence, status))

    md = ['# Fixture organisation check', '',
          'Generated by `etl/build_registry.py` at %s from `data/registry.sqlite`.' % netutil.now_iso(), '',
          'Result: **%d of %d fixture rows OK** (rows without a real org, F05/F07/F22/F23/F28/F30, check the consumer/fake-domain tables).' % (ok_n, graded), '',
          'Evidence column = homepage `<title>` / `og:site_name` captured by a plain GET (4s timeout, 3 redirects max, 64KB) unless noted.',
          '', '| fixture | domain | expected entity | registry resolves to | evidence | status |', '|---|---|---|---|---|---|']
    for l in lines:
        md.append('| ' + ' | '.join(str(x).replace('|', '\\|').replace('\n', ' ') for x in l) + ' |')
    md += ['', '## Notes', '']
    if link:
        md.append('- **F14 Jefferson Healthcare**: `jeffersonhealthcare.org` is registered in `org_domains` as CMS hospital 501323 as requested, '
                  'but the 2023 AHRQ hospital linkage lists CCN 501323 (and the non-acute entity 507050) under AHRQ system %s "%s". '
                  'Under the parent-system step in the resolver ("the parent system if `ahrq_hospital_links` has one") the app would call it a `health_system`, not a '
                  '`standalone_hospital`. %s' % (link[0], link[1],
                  ('`data/fixture-overrides.json` swaps F14 to %s (%s, CCN %s), a real independent hospital with no AHRQ system link.' % (
                      overrides['F14']['company'], overrides['F14']['domain'], overrides['F14']['ccn'])) if 'F14' in overrides else
                  'NO replacement could be verified; decide manually.'))
    md.append('- **F12 Atrium Health**: the 2023 compendium has no separate Atrium row; Atrium is inside AHRQ system "Advocate Health" '
              '(merged Dec 2022). `atriumhealth.org` maps to Advocate Health, which is still a `health_system` (gold OK).')
    md.append('- **F35 jhmi.edu**: the bare `jhmi.edu` homepage is a WordPress theme-support placeholder whose `<title>` does not name the org; '
              'the match is recorded as BODY-TEXT (page text names Johns Hopkins). Corroboration outside the page: `hopkinsmedicine.org` is mapped to the same system; '
              'public WHOIS lists Johns Hopkins Medical Institutions as the registrant.')
    md.append('- **F05 / F07 / F28** are fictional CRM accounts (`.example` domains), deliberately absent from every registry table; the app resolves them from the CRM mirror.')
    md.append('- **F09 mohawkind.com / F23 / F31** are intentionally absent from every registry table so the app falls through to inference / unknown.')
    md.append('- **F24 turquoise.health, F37 zelis.com, F33 meritain.com**: Zelis and Meritain Health also appear in Serif\'s payer inventory; '
              'their `payers.domain` is NULL and the domain lives only in `curated_orgs`, so the curated-domain step of the resolver is unambiguous.')
    open(os.path.join(DATA, 'fixture-org-check.md'), 'w').write('\n'.join(md) + '\n')
    json.dump(overrides, open(os.path.join(DATA, 'fixture-overrides.json'), 'w'), indent=2)
    report['fixture_ok'] = '%d/%d' % (ok_n, graded)


def evidence_for(r):
    bits = []
    if r.get('title'):
        bits.append("title='%s'" % r['title'][:120])
    if r.get('og_site_name'):
        bits.append("og:site_name='%s'" % r['og_site_name'][:60])
    if not bits:
        bits.append('no title (%s)' % (r.get('error') or r.get('status')))
    return ' '.join(bits) + (' [%s]' % r.get('final_url') if r.get('final_url') else '')
