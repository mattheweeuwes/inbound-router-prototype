#!/usr/bin/env python3
"""Build data/registry.sqlite for the Inbound Router prototype.

Idempotent: rebuilds the whole DB from data/raw/ caches and the homepage cache; downloads
only what is missing.  The DB is written to registry.sqlite.building and atomically renamed
at the very end; meta.status='complete' is the last statement executed.

Python 3.9, standard library only.   Usage:  python3 etl/build_registry.py [--no-wikidata]
"""
import csv
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import gzip
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from name_norm import name_norm          # noqa: E402
import netutil                           # noqa: E402
import curated                           # noqa: E402

ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
RAW = os.path.join(DATA, 'raw')
DB_FINAL = os.path.join(DATA, 'registry.sqlite')
DB_TMP = DB_FINAL + '.building'
SOURCES_JSON = os.path.join(RAW, 'sources.json')
COMPENDIUM_YEAR = 2023
WIKIDATA_BUDGET_SECONDS = 75 * 60

# A saved copy of the payer inventory page, used only to report whether the page's text lists payers.
SERIF_SNAPSHOT = os.environ.get('SERIF_PAYERS_SNAPSHOT') or os.path.join(HERE, '..', 'data', 'raw', 'serif_payers_page.html')
SERIF_PAGE = 'https://www.serifhealth.com/inventory/payers/'
SERIF_FEED = 'https://www.serifhealth.com/data/payers.json'
CMS_META = 'https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/xubh-q36u'
AHRQ_PAGE = 'https://www.ahrq.gov/chsp/data-resources/compendium-%d.html' % COMPENDIUM_YEAR
AHRQ_BASE = 'https://www.ahrq.gov/sites/default/files/wysiwyg/chsp/compendium/'
AHRQ_SYSTEM_FILE = 'chsp-compendium-%d-rev.csv' % COMPENDIUM_YEAR
AHRQ_LINK_FILE = 'chsp-hospital-linkage-%d.csv' % COMPENDIUM_YEAR
WD_UA = 'inbound-router-prototype/0.1 (public-data ETL for a portfolio prototype; Python urllib)'

SEGMENTS = set(['benefits_consultant_broker', 'tpa', 'innovator_navigation', 'innovator_api_data', 'life_sciences',
                'pe_investor', 'consulting_advisory', 'media', 'competitor', 'academic', 'government'])

SCHEMA = """
CREATE TABLE cms_hospitals(ccn TEXT PRIMARY KEY, name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, county TEXT,
  phone TEXT, hospital_type TEXT, ownership TEXT, emergency TEXT, overall_rating INTEGER, name_norm TEXT);
CREATE TABLE ahrq_systems(health_sys_id TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT, hosp_cnt INTEGER,
  acutehosp_cnt INTEGER, sys_beds INTEGER, total_mds INTEGER, multistate INTEGER, name_norm TEXT, source_year INTEGER);
CREATE TABLE ahrq_hospital_links(ccn TEXT, health_sys_id TEXT, hospital_name TEXT, state TEXT, beds INTEGER,
  source_year INTEGER, PRIMARY KEY(ccn, health_sys_id));
CREATE TABLE payers(slug TEXT PRIMARY KEY, name TEXT, parent TEXT, domain TEXT, kind TEXT, source TEXT, name_norm TEXT);
CREATE TABLE curated_orgs(domain TEXT PRIMARY KEY, name TEXT, segment TEXT, subsegment TEXT, size_class TEXT,
  source_url TEXT, dns_ok INTEGER);
CREATE TABLE org_domains(domain TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, name TEXT, evidence TEXT,
  verified_at TEXT);
CREATE TABLE free_mail_domains(domain TEXT PRIMARY KEY);
CREATE TABLE disposable_domains(domain TEXT PRIMARY KEY);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX idx_cms_name_norm ON cms_hospitals(name_norm);
CREATE INDEX idx_cms_state ON cms_hospitals(state);
CREATE INDEX idx_ahrq_name_norm ON ahrq_systems(name_norm);
CREATE INDEX idx_links_sys ON ahrq_hospital_links(health_sys_id);
CREATE INDEX idx_links_ccn ON ahrq_hospital_links(ccn);
CREATE INDEX idx_payers_name_norm ON payers(name_norm);
CREATE INDEX idx_org_domains_entity ON org_domains(entity_type, entity_id);
"""

STATE_ABBR = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA', 'Colorado': 'CO',
    'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
    'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA',
    'Maine': 'ME', 'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN',
    'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
    'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
    'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA',
    'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX',
    'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
    'Wisconsin': 'WI', 'Wyoming': 'WY', 'District of Columbia': 'DC', 'Puerto Rico': 'PR',
}

LOG_T0 = time.time()


def log(*a):
    print('[%6.1fs]' % (time.time() - LOG_T0), *a, flush=True)


# ------------------------------------------------------------------ raw downloads
def load_sources():
    if os.path.exists(SOURCES_JSON):
        return json.load(open(SOURCES_JSON))
    return {}


def save_sources(d):
    json.dump(d, open(SOURCES_JSON, 'w'), indent=1, sort_keys=True)


def http_get(url, headers=None, timeout=120):
    h = {'User-Agent': 'Mozilla/5.0 (compatible; inbound-router-prototype/0.1)', 'Accept-Encoding': 'gzip'}
    h.update(headers or {})
    r = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)
    b = r.read()
    if b[:2] == b'\x1f\x8b':
        b = gzip.decompress(b)
    return b, r.status


def wayback_url(url):
    """Closest Internet Archive snapshot of an AHRQ file (raw bytes, id_ flag)."""
    meta = json.loads(http_get('https://archive.org/wayback/available?url=' + urllib.parse.quote(url, safe=':/'))[0])
    snap = meta.get('archived_snapshots', {}).get('closest')
    if not snap or not snap.get('available'):
        raise RuntimeError('no wayback snapshot for ' + url)
    m = re.match(r'https?://web\.archive\.org/web/(\d+)/(.*)$', snap['url'])
    return 'https://web.archive.org/web/%sid_/%s' % (m.group(1), m.group(2)), snap['timestamp']


def ensure_raw():
    os.makedirs(RAW, exist_ok=True)
    src = load_sources()

    # 1. CMS Hospital General Information
    p = os.path.join(RAW, 'hospital_general_information.csv')
    if not os.path.exists(p):
        log('download CMS metastore + CSV')
        meta = json.loads(http_get(CMS_META)[0])
        open(os.path.join(RAW, 'cms_meta.json'), 'w').write(json.dumps(meta, indent=1))
        url = meta['distribution'][0]['downloadURL']
        open(p, 'wb').write(http_get(url)[0])
        src['cms_hospital_general_information'] = {'url': url, 'retrieved_at': netutil.now_iso(),
                                                   'metastore': CMS_META, 'modified': meta.get('modified')}
    else:
        meta = json.load(open(os.path.join(RAW, 'cms_meta.json')))
        src.setdefault('cms_hospital_general_information', {
            'url': meta['distribution'][0]['downloadURL'], 'metastore': CMS_META, 'modified': meta.get('modified'),
            'retrieved_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(os.path.getmtime(p)))})

    # 2. AHRQ compendium (www.ahrq.gov sits behind an AWS WAF bot challenge: plain HTTP clients get 202/403).
    for key, fname, out in (('ahrq_systems', AHRQ_SYSTEM_FILE, 'ahrq_compendium_%d_systems.csv' % COMPENDIUM_YEAR),
                            ('ahrq_hospital_linkage', AHRQ_LINK_FILE, 'ahrq_hospital_linkage_%d.csv' % COMPENDIUM_YEAR)):
        p = os.path.join(RAW, out)
        if not os.path.exists(p):
            orig = AHRQ_BASE + fname
            log('download', key)
            body = None
            try:
                b, st = http_get(orig, timeout=30)
                if st == 200 and b[:8].lower().find(b'<html') < 0:
                    body = b
                    via = orig
            except Exception as e:
                log('  direct ahrq.gov download blocked (%s); using Internet Archive snapshot of the same file' % e)
            if body is None:
                wb, ts = wayback_url(orig)
                body = http_get(wb)[0]
                via = wb
            open(p, 'wb').write(body)
            src[key] = {'url': orig, 'fetched_via': via, 'retrieved_at': netutil.now_iso(), 'page': AHRQ_PAGE}
        else:
            src.setdefault(key, {'url': AHRQ_BASE + fname, 'page': AHRQ_PAGE,
                                 'fetched_via': 'Internet Archive snapshot 20260923 of the ahrq.gov file (ahrq.gov blocks scripted clients)',
                                 'retrieved_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(os.path.getmtime(p)))})

    # 3. Serif payer inventory.  The page is a Vue island that loads /data/payers.json at runtime;
    #    the text snapshot only holds "Loading payers…", so the JSON feed behind the page is used.
    p = os.path.join(RAW, 'serif_payers.json')
    if not os.path.exists(p):
        log('download serif payers.json')
        open(p, 'wb').write(http_get(SERIF_FEED)[0])
        src['serif_payers'] = {'url': SERIF_FEED, 'page': SERIF_PAGE, 'retrieved_at': netutil.now_iso()}
    else:
        src.setdefault('serif_payers', {'url': SERIF_FEED, 'page': SERIF_PAGE,
                                        'retrieved_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(os.path.getmtime(p)))})
    save_sources(src)
    return src


def snapshot_usable():
    try:
        t = open(SERIF_SNAPSHOT).read()
    except Exception:
        return False, 'snapshot file not readable'
    names = [n for n in ('Aetna', 'Anthem', 'Cigna', 'UnitedHealthcare', 'Humana') if n in t]
    if len(names) >= 3:
        return True, 'snapshot lists payers'
    return False, 'snapshot is the JS shell only (%d chars, "Loading payers…"), no payer names' % len(t)


# ------------------------------------------------------------------ verification
GENERIC = set(['health', 'healthcare', 'hospital', 'hospitals', 'system', 'systems', 'medical', 'center', 'centers',
               'services', 'care', 'group', 'network', 'clinic', 'partners', 'association', 'foundation', 'plan',
               'plans', 'and', 'insurance', 'inc', 'regional', 'memorial', 'community', 'university', 'general',
               'corporation', 'authority', 'district', 'county', 'city', 'state'])


def _tok(s):
    s = name_norm(s).replace(' saint ', ' st ')
    toks = ['st' if t == 'saint' else t for t in s.split()]
    return toks


def title_match(names, res, allow_body=False):
    """Does the homepage identify the entity?  Returns (ok, evidence).  All DISTINCTIVE tokens of at least
    one candidate name must appear in <title>/og:site_name/og:title (token or substring of the compact text)."""
    if not res or (res.get('status') or 0) >= 500:
        return False, 'no usable response (%s)' % (res or {}).get('error')
    fields = [res.get('title'), res.get('og_site_name'), res.get('og_title')]
    hay = ' '.join(f for f in fields if f)
    if not hay and not (allow_body and res.get('text')):
        return False, 'no title (status %s, %s)' % (res.get('status'), res.get('error'))
    htoks = set(_tok(hay))
    compact = re.sub(r'[^a-z0-9]', '', hay.lower())
    for nm in names:
        toks = _tok(nm)
        distinct = [t for t in toks if t not in GENERIC] or toks
        if not distinct:
            continue
        if all((t in htoks) or (len(t) >= 4 and t in compact) for t in distinct):
            return True, evidence_text(res)
    if allow_body and res.get('text'):
        btoks = set(_tok(res['text']))
        bcompact = re.sub(r'[^a-z0-9]', '', res['text'].lower())
        for nm in names:
            toks = _tok(nm)
            distinct = [t for t in toks if t not in GENERIC] or toks
            if distinct and all((t in btoks) or (len(t) >= 4 and t in bcompact) for t in distinct):
                return True, 'BODY-TEXT MATCH (title generic): ' + evidence_text(res) + " | page text: '" + res['text'][:160] + "'"
    return False, evidence_text(res)


def evidence_text(res):
    bits = []
    if res.get('title'):
        bits.append("title='%s'" % res['title'][:140])
    if res.get('og_site_name'):
        bits.append("og:site_name='%s'" % res['og_site_name'][:80])
    if res.get('og_title') and res.get('og_title') != res.get('title'):
        bits.append("og:title='%s'" % res['og_title'][:100])
    bits.append('GET %s -> %s' % (res.get('url'), res.get('final_url') or res.get('status')))
    return ' | '.join(bits)


BLOCK_PAT = netutil.BLOCK_PAT
unreadable = netutil.unreadable


_WD_INDEX = {}


def wd_index():
    """official-website domain -> [(qid, label)] from the cached Wikidata results (independent public source)"""
    if _WD_INDEX:
        return _WD_INDEX
    for fn in ('wikidata_systems.json', 'wikidata_hospitals.json'):
        p = os.path.join(RAW, fn)
        if not os.path.exists(p):
            continue
        for r in json.load(open(p))['results']['bindings']:
            lab = r['itemLabel']['value']
            dom = wd_domain(r['site']['value'])
            if dom and not re.match(r'^Q\d+$', lab):
                _WD_INDEX.setdefault(dom, []).append((r['item']['value'].split('/')[-1], lab, r['site']['value']))
    return _WD_INDEX


def accept(names, res, dom, allow_body=False):
    """Tier 1: homepage title/og names the entity.  Tier 2 (only when the homepage is unreadable because of a bot
    challenge / error page / network failure; the challenge is NOT bypassed): Wikidata lists exactly this domain as the
    official website of an item whose label contains every distinctive token of the entity name."""
    ok, ev = title_match(names, res, allow_body=allow_body)
    if ok:
        return True, ev
    if unreadable(res):
        for qid, lab, site in wd_index().get(dom, []):
            ltoks = set(_tok(lab))
            for nm in names:
                toks = _tok(nm)
                distinct = [t for t in toks if t not in GENERIC] or toks
                if distinct and all(t in ltoks or (len(t) >= 4 and t in re.sub(r'[^a-z0-9]', '', lab.lower())) for t in distinct):
                    return True, ('WIKIDATA-P856-ONLY (homepage unreadable, bot challenge not bypassed): wikidata:%s label=%r official website=%s'
                                  ' | fetch: %s' % (qid, lab, site, evidence_text(res or {})))
    return False, ev


def prefetch(vc, domains, label):
    todo = [d for d in sorted(set(domains)) if d not in vc.d]
    if not todo:
        return
    log('fetching %d homepages for %s (4 concurrent, 0.3s spacing)' % (len(todo), label))
    done = [0]

    def one(d):
        try:
            vc.get(d)
        except Exception as e:
            vc.d[d] = {'domain': d, 'error': 'EXC %s' % e, 'fetched_at': netutil.now_iso()}
        done[0] += 1
        if done[0] % 100 == 0:
            vc.save()
            log('  %d/%d' % (done[0], len(todo)))
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(one, todo))
    vc.save()


# ------------------------------------------------------------------ table loaders
def read_csv(path, enc='cp1252'):
    with open(path, encoding=enc, errors='replace', newline='') as f:
        return list(csv.DictReader(f))


def to_int(x):
    try:
        return int(float(str(x).strip()))
    except Exception:
        return None


def load_cms(conn):
    rows = read_csv(os.path.join(RAW, 'hospital_general_information.csv'), 'utf-8-sig')
    out = []
    for r in rows:
        ccn = (r['Facility ID'] or '').strip().zfill(6)
        rating = to_int(r.get('Hospital overall rating'))
        out.append((ccn, r['Facility Name'].strip(), r['Address'].strip(), r['City/Town'].strip(), r['State'].strip(),
                    r['ZIP Code'].strip(), r['County/Parish'].strip(), r['Telephone Number'].strip(),
                    r['Hospital Type'].strip(), r['Hospital Ownership'].strip(), r['Emergency Services'].strip(),
                    rating, name_norm(r['Facility Name'])))
    conn.executemany('INSERT INTO cms_hospitals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', out)
    return len(out)


def load_ahrq(conn):
    S = read_csv(os.path.join(RAW, 'ahrq_compendium_%d_systems.csv' % COMPENDIUM_YEAR))
    out = []
    for r in S:
        multistate = 1 if (to_int(r.get('sys_multistate')) or 0) >= 2 else 0
        out.append((r['health_sys_id'].strip(), r['health_sys_name'].strip(), r['health_sys_city'].strip(),
                    r['health_sys_state'].strip(), to_int(r['hosp_cnt']), to_int(r['acutehosp_cnt']),
                    to_int(r['sys_beds']), to_int(r['total_mds']), multistate, name_norm(r['health_sys_name']),
                    COMPENDIUM_YEAR))
    conn.executemany('INSERT INTO ahrq_systems VALUES (?,?,?,?,?,?,?,?,?,?,?)', out)
    L = read_csv(os.path.join(RAW, 'ahrq_hospital_linkage_%d.csv' % COMPENDIUM_YEAR))
    links = {}
    for r in L:
        ccn = (r['ccn'] or '').strip()
        sid = (r['health_sys_id'] or '').strip()
        if not ccn or not sid:
            continue          # hospitals that belong to no compendium system, or lack a CCN, are not links
        ccn = ccn.zfill(6)
        links[(ccn, sid)] = (ccn, sid, r['hospital_name'].strip(), r['hospital_state'].strip(),
                             to_int(r.get('hos_beds')), COMPENDIUM_YEAR)
    conn.executemany('INSERT INTO ahrq_hospital_links VALUES (?,?,?,?,?,?)', list(links.values()))
    return len(out), len(links)


def load_free_disposable(conn):
    conn.executemany('INSERT OR IGNORE INTO free_mail_domains VALUES (?)', [(d,) for d in sorted(set(curated.FREE_MAIL))])
    conn.executemany('INSERT OR IGNORE INTO disposable_domains VALUES (?)', [(d,) for d in sorted(set(curated.DISPOSABLE))])


# ------------------------------------------------------------------ payers
def parse_parent_default(name):
    return None


def build_payers(conn, vc, report):
    ok, why = snapshot_usable()
    report['payer_snapshot'] = why
    log('payer snapshot usable:', ok, '-', why)
    feed = json.load(open(os.path.join(RAW, 'serif_payers.json')))
    seed = curated.PAYER_SEED
    prefetch(vc, [v[0] for v in seed.values() if v[0]], 'payer domains')
    rows = []
    domains = {}
    seen = set()
    for p in feed:
        slug, name = p['payorSlug'], p['payorName'].strip()
        if slug in seen:
            continue
        seen.add(slug)
        dom, aliases, kind, parent = seed.get(slug, (None, [], 'regional', None))
        verified = None
        if dom:
            res = vc.get(dom)
            good, ev = title_match([name] + list(aliases), res)
            if good:
                verified = dom
                domains[dom] = (slug, name, ev)
            else:
                report.setdefault('payer_domain_rejected', []).append([slug, dom, ev])
        rows.append((slug, name, parent, verified, kind, 'serif_inventory', name_norm(name)))
    conn.executemany('INSERT INTO payers VALUES (?,?,?,?,?,?,?)', rows)
    report['payer_slugs_unseeded'] = sorted(s for s in seed if s not in seen)
    return len(rows), domains


# ------------------------------------------------------------------ curated orgs
def build_curated(conn, vc, report):
    prefetch(vc, [o[0] for o in curated.CURATED_ORGS], 'curated orgs')
    rows = []
    review = []
    for dom, name, seg, sub, size in curated.CURATED_ORGS:
        assert seg in SEGMENTS, (dom, seg)
        dns = 1 if netutil.dns_ok(dom) else 0
        res = vc.d.get(dom) or {}
        good, ev = title_match([name], res)
        if not dns:
            review.append([dom, name, 'DNS FAILS: dropped'])
            continue
        if not good:
            review.append([dom, name, 'title does not name org (kept only if reviewed): ' + ev])
        rows.append((dom, name, seg, sub, size, 'https://%s/' % dom, dns))
    report['curated_review'] = review
    return rows


# ------------------------------------------------------------------ org_domains
def sysmap(conn):
    by_name = {}
    for r in conn.execute('SELECT health_sys_id, name, state FROM ahrq_systems'):
        by_name.setdefault(r[1], []).append(r)
    return by_name


def build_org_domains(conn, vc, report, payer_domains, curated_domains):
    od = {}
    reserved = set(curated_domains) | set(r[0] for r in conn.execute('SELECT domain FROM free_mail_domains')) \
        | set(r[0] for r in conn.execute('SELECT domain FROM disposable_domains'))
    by_name = sysmap(conn)
    all_seed = [(n, d, a, 'seed') for (n, d, a) in curated.SYSTEM_SEED] + \
               [(n, d, a, 'seed-extra') for (n, d, a) in curated.SYSTEM_EXTRA_DOMAINS]
    prefetch(vc, [d for (_, d, _, _) in all_seed], 'health-system seed domains')
    now = netutil.now_iso()
    rejected = []
    missing = []
    for nm, dom, aliases, tag in all_seed:
        if dom in reserved or dom in od:
            continue
        cands = by_name.get(nm)
        if not cands:
            missing.append([nm, dom, 'AHRQ system name not found'])
            continue
        if nm == 'Jefferson Healthcare':
            continue     # handled as a CMS hospital below (fixture F14)
        sid, sname, _st = cands[0]
        allow_body = (dom == 'jhmi.edu')
        good, ev = accept([sname, nm] + list(aliases), vc.d.get(dom), dom, allow_body=allow_body)
        if good:
            od[dom] = ('ahrq_system', sid, sname, '%s | %s' % (tag, ev), now)
        else:
            rejected.append([nm, dom, ev])
    report['system_seed_rejected'] = rejected
    report['system_seed_missing'] = missing
    # payers (curated orgs win on conflict)
    for dom, (slug, name, ev) in payer_domains.items():
        if dom in reserved:
            report.setdefault('payer_domain_also_curated', []).append(dom)
            continue
        if dom not in od:
            od[dom] = ('payer', slug, name, 'seed | ' + ev, now)
    # Jefferson Healthcare (fixture F14): standalone CMS hospital CCN 501323
    jh = conn.execute("SELECT ccn, name FROM cms_hospitals WHERE ccn='501323'").fetchone()
    if jh:
        good, ev = accept(['Jefferson Healthcare'], vc.get('jeffersonhealthcare.org'), 'jeffersonhealthcare.org')
        if good:
            od['jeffersonhealthcare.org'] = ('cms_hospital', jh[0], jh[1], 'seed | ' + ev, now)
    return od


# ------------------------------------------------------------------ Wikidata extension
def wd_query(rq_path, out_path):
    if os.path.exists(out_path):
        src = load_sources()
        src.setdefault(os.path.basename(out_path), {
            'url': 'https://query.wikidata.org/sparql', 'query_file': os.path.relpath(rq_path, ROOT),
            'retrieved_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(os.path.getmtime(out_path)))})
        save_sources(src)
        return json.load(open(out_path))['results']['bindings']
    q = open(rq_path).read()
    url = 'https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': q, 'format': 'json'})
    for attempt in range(4):
        try:
            b, _ = http_get(url, headers={'User-Agent': WD_UA, 'Accept': 'application/sparql-results+json'}, timeout=100)
            open(out_path, 'wb').write(b)
            src = load_sources()
            src[os.path.basename(out_path)] = {'url': 'https://query.wikidata.org/sparql', 'query_file': os.path.relpath(rq_path, ROOT),
                                              'retrieved_at': netutil.now_iso()}
            save_sources(src)
            return json.loads(b)['results']['bindings']
        except Exception as e:
            log('wikidata query failed (%s), retry in %ds' % (e, 70))
            time.sleep(70)
    return []


def wd_domain(site):
    try:
        u = urllib.parse.urlparse(site)
    except Exception:
        return None
    host = (u.hostname or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    if u.path not in ('', '/', '/index.html', '/index.htm', '/home', '/home/', '/en', '/en/') or u.query:
        return None
    if len(host.split('.')) != 2:
        return None
    return host


def loose_key(nn):
    drop = set(['health', 'healthcare', 'system', 'systems', 'hospital', 'hospitals', 'network', 'services', 'care',
                'medical', 'center', 'centers', 'group', 'and', 'regional'])
    return ' '.join(t for t in nn.split() if t not in drop)


def wikidata_extend(conn, vc, od, report, reserved, no_wd=False):
    t0 = time.time()
    stats = {'candidates_systems': 0, 'candidates_hospitals': 0, 'matched': 0, 'verified_system': 0,
             'verified_hospital': 0, 'rejected': 0, 'skipped_budget': 0}
    report['wikidata'] = stats
    if no_wd:
        return
    sysrows = wd_query(os.path.join(HERE, 'wikidata_systems.rq'), os.path.join(RAW, 'wikidata_systems.json'))
    hosrows = wd_query(os.path.join(HERE, 'wikidata_hospitals.rq'), os.path.join(RAW, 'wikidata_hospitals.json'))

    systems = list(conn.execute('SELECT health_sys_id, name, state, hosp_cnt, sys_beds, name_norm, multistate FROM ahrq_systems'))
    links_states = {}
    for sid, st in conn.execute('SELECT health_sys_id, state FROM ahrq_hospital_links'):
        links_states.setdefault(sid, set()).add(st)
    by_nn = {}
    by_loose = {}
    for s in systems:
        by_nn.setdefault(s[5], []).append(s)
        by_loose.setdefault(loose_key(s[5]), []).append(s)
    cms = list(conn.execute('SELECT ccn, name, state, name_norm FROM cms_hospitals'))
    cms_by = {}
    for c in cms:
        cms_by.setdefault((c[3], c[2]), []).append(c)
    link_by = {}
    for ccn, sid, hn, st in conn.execute('SELECT ccn, health_sys_id, hospital_name, state FROM ahrq_hospital_links'):
        link_by.setdefault((name_norm(hn), st), set()).add(ccn)
    cms_ccn = dict((c[0], c) for c in cms)

    def pick_system(label, st):
        nn = name_norm(label)
        for pool, key in ((by_nn, nn), (by_loose, loose_key(nn))):
            if not key:
                continue
            c = pool.get(key, [])
            c = [s for s in c if (not st) or s[2] == st or st in links_states.get(s[0], set())]
            if len(c) == 1:
                return c[0]
            if len(c) > 1:
                c.sort(key=lambda s: -(s[3] or 0))
                if (c[0][3] or 0) > (c[1][3] or 0) * 3 and not st:
                    return c[0]
        return None

    def pick_hospital(label, st):
        nn = name_norm(label)
        c = cms_by.get((nn, st), [])
        if len(c) == 1:
            return c[0]
        ccns = link_by.get((nn, st), set())
        if len(ccns) == 1:
            return cms_ccn.get(list(ccns)[0])
        return None

    cand = []
    seen_dom = set()
    for r in sysrows:
        lab = r['itemLabel']['value']
        if re.match(r'^Q\d+$', lab):
            continue
        dom = wd_domain(r['site']['value'])
        if not dom or dom in seen_dom:
            continue
        st = STATE_ABBR.get(r.get('stateLabel', {}).get('value', ''))
        stats['candidates_systems'] += 1
        s = pick_system(lab, st)
        if s:
            cand.append((-(s[3] or 0), -(s[4] or 0), 'ahrq_system', s[0], s[1], dom, lab, r['item']['value'].split('/')[-1]))
            seen_dom.add(dom)
            continue
        h = pick_hospital(lab, st) if st else None
        if h:
            cand.append((1, 0, 'cms_hospital', h[0], h[1], dom, lab, r['item']['value'].split('/')[-1]))
            seen_dom.add(dom)
    for r in hosrows:
        lab = r['itemLabel']['value']
        if re.match(r'^Q\d+$', lab):
            continue
        dom = wd_domain(r['site']['value'])
        if not dom or dom in seen_dom:
            continue
        st = STATE_ABBR.get(r.get('stateLabel', {}).get('value', ''))
        stats['candidates_hospitals'] += 1
        if not st:
            continue
        h = pick_hospital(lab, st)
        if h:
            cand.append((1, 0, 'cms_hospital', h[0], h[1], dom, lab, r['item']['value'].split('/')[-1]))
            seen_dom.add(dom)
        else:
            s = pick_system(lab, st)
            if s:
                cand.append((-(s[3] or 0), -(s[4] or 0), 'ahrq_system', s[0], s[1], dom, lab, r['item']['value'].split('/')[-1]))
                seen_dom.add(dom)
    cand.sort()
    cand = [c for c in cand if c[5] not in od and c[5] not in reserved]
    stats['matched'] = len(cand)
    log('wikidata: %d system-items, %d hospital-items -> %d name+state matches to verify' %
        (stats['candidates_systems'], stats['candidates_hospitals'], len(cand)))
    # cap per entity: at most 3 domains
    per_entity = {}
    final = []
    for c in cand:
        k = (c[2], c[3])
        if per_entity.get(k, 0) >= 3:
            continue
        per_entity[k] = per_entity.get(k, 0) + 1
        final.append(c)
    # fetch in priority order with a wall-clock budget
    batch = 60
    now = netutil.now_iso()
    rej = []
    for i in range(0, len(final), batch):
        if time.time() - t0 > WIKIDATA_BUDGET_SECONDS:
            stats['skipped_budget'] = len(final) - i
            log('wikidata budget exhausted; %d candidates not verified' % stats['skipped_budget'])
            break
        chunk = final[i:i + batch]
        prefetch(vc, [c[5] for c in chunk], 'wikidata batch %d' % (i // batch))
        for pri, _, etype, eid, ename, dom, lab, qid in chunk:
            res = vc.d.get(dom)
            good, ev = title_match([ename, lab], res)
            if good:
                od[dom] = (etype, eid, ename, 'wikidata:%s label=%r | %s' % (qid, lab, ev), now)
                stats['verified_system' if etype == 'ahrq_system' else 'verified_hospital'] += 1
            else:
                stats['rejected'] += 1
                if len(rej) < 400:
                    rej.append([qid, lab, dom, ename, ev])
    report['wikidata_rejected_sample'] = rej
    stats['seconds'] = round(time.time() - t0)


# ------------------------------------------------------------------ meta + main
def main():
    no_wd = '--no-wikidata' in sys.argv
    src = ensure_raw()
    if os.path.exists(DB_TMP):
        os.remove(DB_TMP)
    conn = sqlite3.connect(DB_TMP)
    conn.executescript(SCHEMA)
    conn.execute("INSERT INTO meta VALUES('status','building')")
    conn.commit()
    report = {}
    vc = netutil.VerifyCache(os.path.join(RAW, 'homepage_cache.json'))

    n_cms = load_cms(conn)
    n_sys, n_links = load_ahrq(conn)
    load_free_disposable(conn)
    log('cms=%d ahrq_systems=%d links=%d' % (n_cms, n_sys, n_links))

    n_pay, payer_domains = build_payers(conn, vc, report)
    corg = build_curated(conn, vc, report)
    conn.executemany('INSERT INTO curated_orgs VALUES (?,?,?,?,?,?,?)', corg)
    curated_domains = set(o[0] for o in corg)

    od = build_org_domains(conn, vc, report, payer_domains, curated_domains)
    reserved = set(curated_domains) | set(r[0] for r in conn.execute('SELECT domain FROM free_mail_domains')) \
        | set(r[0] for r in conn.execute('SELECT domain FROM disposable_domains'))
    wikidata_extend(conn, vc, od, report, reserved, no_wd=no_wd)
    vc.save()

    # drop payer.domain values that lost to a curated org, so one domain has exactly one meaning
    for d in report.get('payer_domain_also_curated', []):
        conn.execute('UPDATE payers SET domain=NULL WHERE domain=?', (d,))
    conn.executemany('INSERT OR REPLACE INTO org_domains VALUES (?,?,?,?,?,?)',
                     [(d,) + v for d, v in sorted(od.items())])
    conn.commit()

    # fixture check + overrides (reads the DB; writes data/fixture-org-check.md and fixture-overrides.json)
    import fixture_check
    fixture_check.run(conn, vc, report)
    vc.save()
    conn.commit()

    # meta
    s = load_sources()
    wd_verified = conn.execute("SELECT COUNT(*) FROM org_domains WHERE evidence LIKE 'wikidata:%'").fetchone()[0]
    p856_only = conn.execute("SELECT COUNT(*) FROM org_domains WHERE evidence LIKE '%WIKIDATA-P856-ONLY%'").fetchone()[0]
    title_verified = conn.execute("SELECT COUNT(*) FROM org_domains WHERE evidence NOT LIKE '%WIKIDATA-P856-ONLY%'").fetchone()[0]
    meta = {
        'built_at': netutil.now_iso(),
        'etl': 'etl/build_registry.py',
        'python': sys.version.split()[0],
        'compendium_year': str(COMPENDIUM_YEAR),
        'source_cms': json.dumps(s.get('cms_hospital_general_information')),
        'source_ahrq_systems': json.dumps(s.get('ahrq_systems')),
        'source_ahrq_hospital_linkage': json.dumps(s.get('ahrq_hospital_linkage')),
        'source_serif_payers': json.dumps(s.get('serif_payers')),
        'payer_source_note': report.get('payer_snapshot', ''),
        'source_wikidata_systems': json.dumps(s.get('wikidata_systems.json')),
        'source_wikidata_hospitals': json.dumps(s.get('wikidata_hospitals.json')),
        'wikidata_verified_domains': str(wd_verified),
        'org_domains_title_verified': str(title_verified),
        'org_domains_wikidata_p856_only': str(p856_only),
        'wikidata_stats': json.dumps(report.get('wikidata')),
        'name_norm_rule': 'etl/name_norm.py (lowercase, & -> and, strip punctuation, drop inc llc the of corp corporation company co ltd)',
        'multistate_rule': '1 when AHRQ sys_multistate >= 2 (system spans two or more states)',
    }
    for t in ('cms_hospitals', 'ahrq_systems', 'ahrq_hospital_links', 'payers', 'curated_orgs', 'org_domains',
              'free_mail_domains', 'disposable_domains'):
        meta['rows_' + t] = str(conn.execute('SELECT COUNT(*) FROM %s' % t).fetchone()[0])
    for k, v in meta.items():
        conn.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (k, v))
    conn.commit()
    json.dump(report, open(os.path.join(RAW, 'build_report.json'), 'w'), indent=1)

    # integrity checks before declaring victory
    assert conn.execute('SELECT COUNT(*) FROM cms_hospitals').fetchone()[0] > 5000
    assert conn.execute('SELECT COUNT(*) FROM ahrq_systems').fetchone()[0] > 600
    assert conn.execute('SELECT COUNT(*) FROM ahrq_hospital_links').fetchone()[0] > 4000
    assert conn.execute('SELECT COUNT(*) FROM payers').fetchone()[0] > 200
    # LAST STEP
    conn.execute("INSERT OR REPLACE INTO meta VALUES('status','complete')")
    conn.commit()
    meta_rows = dict(conn.execute('SELECT key, value FROM meta'))
    conn.close()
    os.replace(DB_TMP, DB_FINAL)
    json.dump(meta_rows, open(os.path.join(DATA, 'registry-meta.json'), 'w'), indent=2, sort_keys=True)
    log('DONE. status=complete')
    for k in sorted(meta_rows):
        if k.startswith('rows_') or k in ('wikidata_verified_domains',):
            print('  %s = %s' % (k, meta_rows[k]))


if __name__ == '__main__':
    main()
