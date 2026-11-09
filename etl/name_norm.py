#!/usr/bin/env python3
"""name_norm: the shared entity-name normalisation rule.

Rule (mirror this exactly in TypeScript match.ts):
  1. Unicode NFKD, drop combining marks (so "Hopital" == "Hôpital").
  2. lowercase.
  3. "&" -> " and ".
  4. delete apostrophes (', U+2019, `) so "St. Luke's" -> "st lukes".
  5. every other non [a-z0-9] character -> a space (punctuation stripped, hyphens split).
  6. split on whitespace; drop the stop tokens
     inc, llc, the, of, corp, corporation, company, co, ltd.
  7. join the remaining tokens with a single space.
Kept on purpose: health, hospital, system, medical, center, and, healthcare.

TypeScript equivalent:
  const STOP = new Set(['inc','llc','the','of','corp','corporation','company','co','ltd']);
  const nameNorm = (s: string) => s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'')
    .toLowerCase().replace(/&/g,' and ').replace(/['\\u2019`]/g,'')
    .replace(/[^a-z0-9]+/g,' ').split(' ').filter(t => t && !STOP.has(t)).join(' ');
Note: after step 1 non-ASCII letters that do not decompose (e.g. a-with-ring is
fine, but "ß" or CJK) become spaces in step 5.  Python and JS agree on that.
"""
import re
import unicodedata

STOP_TOKENS = frozenset(['inc', 'llc', 'the', 'of', 'corp', 'corporation', 'company', 'co', 'ltd'])

_COMBINING = re.compile(r'[\u0300-\u036f]')
_APOS = re.compile(r"['\u2019`]")
_NONALNUM = re.compile(r'[^a-z0-9]+')


def name_norm(s):
    if s is None:
        return ''
    s = unicodedata.normalize('NFKD', str(s))
    s = _COMBINING.sub('', s)
    s = s.lower().replace('&', ' and ')
    s = _APOS.sub('', s)
    s = _NONALNUM.sub(' ', s)
    return ' '.join(t for t in s.split(' ') if t and t not in STOP_TOKENS)


CASES = [
    ('Baptist Health South Florida, Inc.', 'baptist health south florida'),
    ('Johns Hopkins Health System Corporation', 'johns hopkins health system'),
    ('The Johns Hopkins Hospital', 'johns hopkins hospital'),
    ("St. Luke's Health System, Ltd.", 'st lukes health system'),
    ("Brigham & Women's Hospital", 'brigham and womens hospital'),
    ('OhioHealth', 'ohiohealth'),
    ('Blue Cross & Blue Shield of Michigan', 'blue cross and blue shield michigan'),
    ('Cressey & Company', 'cressey and'),
    ('AMG   Integrated-Healthcare Management', 'amg integrated healthcare management'),
    ('Hôpital Sainte-Anne Co.', 'hopital sainte anne'),
    ('Northside Hospital - Gwinnett', 'northside hospital gwinnett'),
    ('', ''),
    ('Inc. LLC The', ''),
]


def _selftest():
    for src, want in CASES:
        got = name_norm(src)
        assert got == want, 'name_norm(%r) = %r, want %r' % (src, got, want)
    assert name_norm(None) == ''
    print('name_norm self-test OK (%d cases)' % len(CASES))


if __name__ == '__main__':
    _selftest()
