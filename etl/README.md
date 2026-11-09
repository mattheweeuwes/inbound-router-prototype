# etl/: building data/registry.sqlite

Python 3.9, standard library only. The app opens `data/registry.sqlite` read-only and switches to it when `meta.status='complete'`.

## Rebuild

```
python3 etl/build_registry.py              # full build (about 1 minute from caches, 8 to 10 minutes cold)
python3 etl/build_registry.py --no-wikidata
python3 etl/name_norm.py                   # name_norm self-test (13 asserts)
```

- Idempotent. Everything is rebuilt from `data/raw/`; only missing files are downloaded.
- The DB is written to `data/registry.sqlite.building` and renamed over `registry.sqlite` at the very end. `meta.status` is `building` until the last statement, which sets `complete`. A failed run leaves the previous `registry.sqlite` untouched.
- Also writes `data/registry-meta.json`, `data/fixture-org-check.md`, `data/fixture-overrides.json`, `data/raw/build_report.json` (rejections and review lists).
- Caches: `data/raw/homepage_cache.json` (every homepage fetch: status, final URL, title, og:site_name, 2KB of page text), `data/raw/sources.json` (URL and UTC retrieval time per source). Delete a key in the homepage cache to re-verify that domain. Delete a raw file to re-download it.

## Files

| file | role |
|---|---|
| `build_registry.py` | main entry point: downloads, loads, verifies, writes the DB and meta |
| `name_norm.py` | the shared `name_norm` rule with TypeScript equivalent in its docstring; `python3 etl/name_norm.py` runs the asserts |
| `netutil.py` | polite homepage fetcher (4s timeout, at most 3 redirects, first 64KB, the prescribed User-Agent, 0.3s spacing, 4 concurrent) and cache |
| `curated.py` | hand-written seed data: payer domains and kinds, curated orgs, health-system domains, free-mail and disposable lists |
| `fixture_check.py` | resolves the fixture organisations against the built DB; writes the check report and overrides |
| `wikidata_systems.rq`, `wikidata_hospitals.rq` | the two SPARQL queries |

## Sources

| table | source | URL | retrieved |
|---|---|---|---|
| cms_hospitals | CMS Provider Data Catalog, Hospital General Information (xubh-q36u), modified 2026-07-22, 5,419 rows | metastore `https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/xubh-q36u` -> distribution `downloadURL` (`.../Hospital_General_Information.csv`) | 2026-11-07 |
| ahrq_systems | AHRQ Compendium of U.S. Health Systems, **2023** (latest year; page `https://www.ahrq.gov/chsp/data-resources/compendium-2023.html`), file `chsp-compendium-2023-rev.csv`, 639 systems | `https://www.ahrq.gov/sites/default/files/wysiwyg/chsp/compendium/chsp-compendium-2023-rev.csv` | 2026-11-07 |
| ahrq_hospital_links | same compendium, Hospital Linkage File `chsp-hospital-linkage-2023.csv`, 6,800 hospital rows, 4,184 with a system | `.../chsp-hospital-linkage-2023.csv` | 2026-11-07 |
| payers | Serif Health public payer inventory page `https://www.serifhealth.com/inventory/payers/`, via its data feed `https://www.serifhealth.com/data/payers.json` (246 payers), `source='serif_inventory'` | see right | 2026-11-07 |
| org_domains (extension) | Wikidata SPARQL, two queries (US items with an official website P856: health systems / hospital networks / medical organisations, and hospitals of 23 hospital subclasses), state resolved through P131 | `https://query.wikidata.org/sparql` | 2026-11-07 |
| curated_orgs, free/disposable lists, payer kinds and domains, health-system seed domains | author's knowledge; every domain checked as below | | |

### Two source problems

1. **ahrq.gov blocks scripted downloads.** Every request to `www.ahrq.gov` from curl, urllib or Python is answered with an AWS WAF bot challenge (HTTP 202 with an empty body, or 403), including the CSV files. I did not try to get around the challenge. The two CSVs were fetched from the Internet Archive's snapshot of the exact same ahrq.gov file URLs (Wayback timestamps 20260923211122 and 20260923211135, raw `id_` bytes, gzip-decoded). File URLs were read from the AHRQ 2023 page in the browser pane (reading a public page); the bytes are not modified. `ensure_raw()` tries ahrq.gov first and falls back to the Internet Archive automatically.
2. **The payer text snapshot is unusable.** `inventory_payers.txt` is the page shell only ("Loading payers…"): the payer list is a Vue island that fetches `/data/payers.json` at runtime. I used that JSON feed (the same data the page shows). The `payers` rows therefore ARE from `serif_inventory`, not `curated`. The feed also carries per-network grades; only `payorName` and `payorSlug` are used.

## Column mappings

**cms_hospitals** (CSV `utf-8-sig`): `Facility ID` -> `ccn` (zero-padded to 6, text); `Facility Name` -> `name`; `Address` -> `address`; `City/Town` -> `city`; `State` -> `state`; `ZIP Code` -> `zip`; `County/Parish` -> `county`; `Telephone Number` -> `phone`; `Hospital Type` -> `hospital_type`; `Hospital Ownership` -> `ownership`; `Emergency Services` -> `emergency` ('Yes'/'No' as published); `Hospital overall rating` -> `overall_rating` (integer 1 to 5, NULL when 'Not Available'); `name_norm` computed.

**ahrq_systems** (compendium CSV, **cp1252**): `health_sys_id`; `health_sys_name` -> `name`; `health_sys_city` -> `city`; `health_sys_state` -> `state`; `hosp_cnt`; `acutehosp_cnt`; `sys_beds`; `total_mds`; `sys_multistate` -> `multistate` (AHRQ codes 1/2/3 = one state / two states / three or more; stored as 1 when >= 2, else 0); `name_norm` computed; `source_year` = 2023.

**ahrq_hospital_links** (linkage CSV, cp1252): `ccn` (zero-padded to 6), `health_sys_id`, `hospital_name`, `hospital_state` -> `state`, `hos_beds` -> `beds` (NULL when blank), `source_year` = 2023. Rows with no `health_sys_id` (hospitals in no system, 2,607) or no `ccn` (124) are not links and are skipped. Not carried: `compendium_hospital_id`, `acutehosp_flag`, `corp_parent_*`, ownership and revenue columns.

**payers**: `payorSlug` -> `slug`, `payorName` -> `name`, `parent` / `kind` / `domain` from `curated.PAYER_SEED` (`kind` defaults to `regional`; non-plan names such as networks, TPAs and vendors are `other`; Blue plans `blue`; Medicaid managed-care plans `medicaid`; the big nationals `national`). `domain` is set only when verified (below). Zelis and Meritain Health are in Serif's payer inventory but are curated orgs for the router (spec fixtures F37, F33), so their `payers.domain` is NULL and the domain lives only in `curated_orgs`. The same rule applies to `imagine360.com`.

## What was verified, and how

**Homepage verification** (payers, health systems, hospitals): GET `https://<domain>/` (4s timeout, at most 3 redirects, 64KB, User-Agent `Mozilla/5.0 (compatible; inbound-router-prototype/0.1)`, 0.3s between fetches, 4 concurrent, cookies kept, a second plain GET to `www.<domain>` when the bare host is unreadable). Pass = every *distinctive* token of the entity name (tokens minus `health, healthcare, hospital, system, medical, center, ...`; `saint` = `st`) appears in `<title>`, `og:site_name` or `og:title`, or as a substring of their compact form (so `OhioHealth` matches `Ohiohealth`). The title text is stored in `org_domains.evidence`. Where the reader cannot see a `<title>` in the first 64KB the ETL reads up to 768KB (one fixture, `priorityhealth.com`, puts its `<title>` at byte 468,000); the **app's** 64KB reader will not see that title, which does not matter because the domain is in `org_domains`.

**Evidence tiers in `org_domains.evidence`:**
- plain: `seed | title=...` or `wikidata:Q... label=... | title=...`: the homepage title names the entity. 656 rows.
- `BODY-TEXT MATCH`: the title is generic and the page text names the entity. One row: `jhmi.edu` (see below).
- `WIKIDATA-P856-ONLY`: the homepage is behind a bot challenge or error page (Cloudflare, Radware, Akamai "Access Denied"). I did not try to defeat the challenge. The row is kept only when Wikidata lists exactly this domain as the official website of an item whose label contains every distinctive token of the entity. Used only for hand-seeded domains (never for the bulk Wikidata extension). 23 rows. Filter them out with `evidence NOT LIKE '%WIKIDATA-P856-ONLY%'` if you want title-verified rows only.

**curated_orgs:** `dns_ok` = `socket.getaddrinfo` succeeded (rows with failing DNS are dropped, so every stored row has `dns_ok=1`). The homepage was fetched as a sanity check; 33 domains returned a bot-challenge page or a title that does not name the org (list in `data/raw/build_report.json` under `curated_review`). All are well-known organisations whose domains I am confident of. I dropped the ones where the fetch showed the domain no longer is that org (Healthcare Bluebook now redirects to Valenz, Buck, Risk Strategies redirects to Brown & Brown, Ribbon Health returns "Site Not Configured", HealthSCOPE redirects to a TPA.com site) and replaced Marsh McLennan with `marsh.com` and Vericred with Ideon (`ideonapi.com`).

**Dead brands** found while verifying and left out: Nuvance Health (now redirects to Northwell), MultiPlan (now Claritev, kept with an alias because the domain still redirects), Optima Health (now Sentara Health Plans, alias).

**Fixtures:** `data/fixture-org-check.md` resolves each of F01 to F40 against the built DB. `data/fixture-overrides.json` swaps F14 (below).

## Known gaps and decisions

- **F14 Jefferson Healthcare.** `jeffersonhealthcare.org` maps to CMS hospital 501323, but the 2023 AHRQ linkage places CCN 501323 (and non-acute entity 507050) under its own 2-record system `HSI00000526`. The resolver's parent-system step would therefore return `health_system`, not the gold `standalone_hospital`. Override: Cascade Medical Center, Leavenworth WA (CCN 501313, domain `cascademedical.org`), a real critical access hospital in CMS and in no AHRQ system. To keep Jefferson Healthcare instead, step 2 would have to prefer a standalone answer when the system has `hosp_cnt <= 2`.
- **F12 Atrium Health** resolves to AHRQ system "Advocate Health" (Atrium merged into it in Dec 2022; there is no Atrium row in the 2023 compendium). Still a health system.
- **F35 jhmi.edu**: the bare homepage is a generic WordPress theme-support page. Evidence is body text ("Johns Hopkins Universal WordPress Theme... for Johns Hopkins University affiliates"). `hopkinsmedicine.org` is mapped to the same system as well.
- **geisinger.org** and **jeffersonhealthcare.org** returned good titles on first contact and Radware / a redirect interstitial afterwards (they challenge repeat fetches from one IP). Cached results may therefore carry `WIKIDATA-P856-ONLY` evidence for them.
- **Bot-blocked homepages, not mapped** (title unverifiable and not on Wikidata with a matching label): HCA Healthcare, Universal Health Services, Tenet, AdventHealth, SSM Health, Mayo Clinic Health System, Billings Clinic, FMOL Health System, LCMC, CentraCare, Saint Luke's (ID), Bryan Health, Adventist Healthcare (MD), Logan Health, Forrest Health. Payers with unreadable homepages have `domain` NULL: Medica, CareFirst, Blue Cross MN, Blue Cross AL, Harvard Pilgrim, AvMed, plus the plans I had no confident domain for. These are the first things to add by hand if the demo needs them.
- Wikidata extension: 829 name+state candidates matched, 447 verified by homepage title (114 AHRQ systems, 333 CMS hospitals), 382 rejected (bot-blocked, parked, or the title names a different org). Homepage-only paths (`/` or `/home`) and two-label hosts only, so a domain like `health.example.edu` or `x.org/hospital/` is never stored. At most 3 domains per entity.
- Hospital-level domains map to `cms_hospital` (ccn). The app should climb to the system through `ahrq_hospital_links`.
- Priority/size: of the 50 largest AHRQ systems (by `hosp_cnt`), 42 have a verified domain; of the top 100, 83.
- `healthpartners.com` is a payer in Serif's inventory and also an AHRQ system. A domain has one meaning, so it is a payer.
- AHRQ 2023 is the latest compendium year published; HQ states and counts are as of that file.
- No paid APIs, no keys. NPPES (free, public) is queried only by `fixture_check.py` to confirm F19/F39 have NPI-2 hits; nothing is cached for the app.
