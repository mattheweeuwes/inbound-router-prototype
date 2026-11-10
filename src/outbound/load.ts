// Loads the rate file at startup and derives everything the outbound module serves, in one transaction: the rows, the
// patterns, one finding per group, its registry link, its fit and draft status. It runs only when the file's hash (or the
// platform mapping, the registry or this derivation) differs from what is stored, so a restart with the same file does no work.
// With no file, or a file that cannot be read, the tables are emptied and the API says why.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { Ctx } from '../context';
import { tx } from '../db';
import { resolveByName } from '../resolve';
import { registryMeta } from '../resolve/registry';
import { hookFor } from './draft';
import { buildFindings, findPatterns } from './findings';
import { parseRateFile } from './rateFile';
import { readPlatforms, targetingOf } from './targeting';

/** Raised when the derivation changes, so a database loaded by older code is rebuilt on the next start. */
export const OUTBOUND_VERSION = 1;

export interface OutboundLoad {
  /** loaded: derived now. unchanged: the stored load matches. missing: no file. failed: the file could not be read. */
  status: 'loaded' | 'unchanged' | 'missing' | 'failed';
  /** the rate file, relative to the project when it is inside it */
  path: string;
  message: string;
  rows: number;
  groups: number;
  ms: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function shownPath(ctx: Ctx, p: string): string {
  const rel = relative(ctx.cfg.root, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p;
}

export function loadOutbound(ctx: Ctx): OutboundLoad {
  const t = performance.now();
  const path = shownPath(ctx, ctx.cfg.ratesCsv);
  const done = (status: OutboundLoad['status'], message: string, rows = 0, groups = 0): OutboundLoad =>
    ({ status, path, message, rows, groups, ms: Math.round(performance.now() - t) });
  const store = ctx.store.outbound;

  if (!existsSync(ctx.cfg.ratesCsv)) {
    tx(ctx.db, () => store.clear());
    return done('missing', `No rate file at ${path}. npm run rates:fetch downloads Serif's public export there.`);
  }
  const text = readFileSync(ctx.cfg.ratesCsv, 'utf8');
  const fileSha = sha256(text);
  const platformsText = existsSync(ctx.cfg.outboundPlatforms) ? readFileSync(ctx.cfg.outboundPlatforms, 'utf8') : '';
  const inputsSha = sha256(JSON.stringify([OUTBOUND_VERSION, fileSha, platformsText, registryMeta(ctx.db)]));
  const stored = store.file();
  if (stored && stored.path === path && stored.sha256 === fileSha && stored.inputsSha256 === inputsSha) {
    return done('unchanged', `${path} is already loaded (sha256 ${fileSha.slice(0, 12)})`, stored.rows, store.allGroups().length);
  }

  try {
    const parsed = parseRateFile(text);
    const platforms = readPlatforms(ctx.cfg.outboundPlatforms);
    const groups = tx(ctx.db, () => {
      store.clear();
      store.insertRows(parsed.rows);
      const patterns = findPatterns(store.distinctRates());
      store.savePatterns(patterns);
      const findings = buildFindings(store.groups(), patterns);
      for (const f of findings) {
        const link = resolveByName(ctx, f.name, f.state);
        store.saveLink(f.ein, link);
        store.saveGroup({ ...f, ...targetingOf(f, link, platforms.get(f.ein)), hook: hookFor(f.ein) });
      }
      store.saveFile({ path, sha256: fileSha, inputsSha256: inputsSha, rows: parsed.rows.length, scope: parsed.scope, loadedAt: new Date(ctx.cfg.now()).toISOString() });
      return findings.length;
    });
    return done('loaded', `${path}: ${parsed.rows.length} rate rows, ${groups} groups`, parsed.rows.length, groups);
  } catch (e) {
    tx(ctx.db, () => store.clear());
    return done('failed', `${path} could not be loaded: ${(e as Error).message}`);
  }
}
