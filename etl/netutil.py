"""Polite homepage fetcher + title extractor + verification cache (stdlib only)."""
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
import http.cookiejar
from html.parser import HTMLParser

UA = 'Mozilla/5.0 (compatible; inbound-router-prototype/0.1)'
TIMEOUT = 4
MAX_REDIRECTS = 3
MAX_BYTES = 64 * 1024
EXT_BYTES = 768 * 1024   # ETL-only: keep reading when no <title> in the first 64KB
MIN_GAP = 0.3          # seconds between fetch starts, global
MAX_CONCURRENT = 4

_gap_lock = threading.Lock()
_last_start = [0.0]
_sem = threading.Semaphore(MAX_CONCURRENT)
_cache_lock = threading.Lock()


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def dns_ok(domain):
    try:
        socket.setdefaulttimeout(4)
        socket.getaddrinfo(domain, 443)
        return True
    except Exception:
        return False


class _Head(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.title = None
        self._in_title = False
        self._buf = []
        self.og_site_name = None
        self.og_title = None
        self.meta_refresh = None
        self.text = []
        self._skip = 0
        self._tlen = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('script', 'style', 'noscript', 'template'):
            self._skip += 1
        if tag == 'title' and self.title is None:
            self._in_title = True
            self._buf = []
        elif tag == 'meta':
            prop = (a.get('property') or a.get('name') or '').lower()
            c = a.get('content')
            if prop == 'og:site_name' and c:
                self.og_site_name = c.strip()
            elif prop == 'og:title' and c:
                self.og_title = c.strip()
            elif (a.get('http-equiv') or '').lower() == 'refresh' and c:
                self.meta_refresh = c

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript', 'template') and self._skip:
            self._skip -= 1
        if tag == 'title' and self._in_title:
            self._in_title = False
            self.title = re.sub(r'\s+', ' ', ''.join(self._buf)).strip()

    def handle_data(self, data):
        if self._in_title:
            self._buf.append(data)
        elif not self._skip and self._tlen < 2500:
            d = data.strip()
            if d:
                self.text.append(d)
                self._tlen += len(d)


class _LimitedRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = MAX_REDIRECTS
    max_repeats = MAX_REDIRECTS

    def http_error_308(self, req, fp, code, msg, headers):  # py3.9 lacks 308 support
        return self.http_error_302(req, fp, code, msg, headers)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if code == 308:
            code = 307
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


def _throttle():
    with _gap_lock:
        wait = _last_start[0] + MIN_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_start[0] = time.time()


def fetch_homepage(domain, scheme_host=None):
    """GET https://<domain>/ -> dict(status, final_url, title, og_site_name, error)."""
    url = 'https://%s/' % (scheme_host or domain)
    out = {'domain': domain, 'url': url, 'status': None, 'final_url': None, 'title': None,
           'og_site_name': None, 'og_title': None, 'error': None, 'fetched_at': now_iso()}
    with _sem:
        _throttle()
        opener = urllib.request.build_opener(_LimitedRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8',
                                                    'Accept-Encoding': 'identity'})
        try:
            resp = opener.open(req, timeout=TIMEOUT)
            out['status'] = resp.status
            out['final_url'] = resp.geturl()
            data = resp.read(MAX_BYTES)
            if b'</title>' not in data.lower():
                out['read_extended'] = True
                data += resp.read(EXT_BYTES - MAX_BYTES)
        except urllib.error.HTTPError as e:
            out['status'] = e.code
            out['final_url'] = e.geturl()
            out['error'] = 'HTTP %s' % e.code
            try:
                data = e.read(MAX_BYTES)
            except Exception:
                data = b''
        except Exception as e:  # timeout, DNS, TLS, too many redirects
            out['error'] = '%s: %s' % (type(e).__name__, str(e)[:120])
            return out
    try:
        text = data.decode('utf-8', errors='replace')
    except Exception:
        text = ''
    p = _Head()
    try:
        p.feed(text)
    except Exception:
        pass
    out['title'] = p.title
    out['og_site_name'] = p.og_site_name
    out['og_title'] = p.og_title
    out['text'] = re.sub(r'\s+', ' ', ' '.join(p.text))[:2000]
    return out


BLOCK_PAT = re.compile(r'just a moment|attention required|access denied|security checkpoint|captcha|being redirected|'
                       r'error 40\d|forbidden|site maintenance|moved permanently|404 not found|^home$|^homepage$', re.I)


def unreadable(res):
    """homepage could not be read as the org's own page: network error, empty title, or a bot-challenge/error page"""
    if not res:
        return True
    t = (res.get('title') or '').strip()
    return (not t) or bool(BLOCK_PAT.search(t))


class VerifyCache(object):
    """domain -> fetch result, persisted in data/raw/homepage_cache.json."""

    def __init__(self, path):
        self.path = path
        self.d = {}
        if os.path.exists(path):
            try:
                self.d = json.load(open(path))
            except Exception:
                self.d = {}

    def get(self, domain, refresh_errors=False):
        with _cache_lock:
            r = self.d.get(domain)
        if r is not None and not (refresh_errors and r.get('error') and not r.get('title')):
            return r
        res = fetch_homepage(domain)
        if unreadable(res) and not domain.startswith('www.'):
            # one more plain GET against the www. host (some sites only challenge the bare host).  No evasion beyond that.
            alt = fetch_homepage(domain, 'www.' + domain)
            if not unreadable(alt) or (alt.get('title') and not res.get('title')):
                alt['domain'] = domain
                alt['note'] = 'fetched via www.'
                res = alt
        with _cache_lock:
            self.d[domain] = res
        return res

    def save(self):
        with _cache_lock:
            tmp = self.path + '.tmp'
            json.dump(self.d, open(tmp, 'w'), indent=1, sort_keys=True)
            os.replace(tmp, self.path)
