// Who the outbound finding is for, encoding the take-home's judgement (Part 1, section 2): the buyer is behavioral health
// MSOs and multi-state psychiatry platforms. Small independent groups are the subject of the finding, not the buyer, and
// hospital systems are winning here, so the finding is not their problem. Organization type is not a field in the file,
// so a platform is only known from the hand-made mapping, and an entity is only called a platform's once that is confirmed.
import { existsSync, readFileSync } from 'node:fs';
import type { NameLink } from '../resolve';
import type { Finding } from './findings';

export interface PlatformMapping {
  ein: string;
  platform: string;
  /** true only when someone confirmed the EIN is the platform's; until then no draft goes out under the platform's name */
  confirmed: boolean;
  /** how it was mapped, in a few words */
  how: string;
}

interface PlatformFile { platforms?: PlatformMapping[] }

/** The hand-made platform mapping by EIN. A missing file maps nothing. */
export function readPlatforms(path: string): Map<string, PlatformMapping> {
  if (!existsSync(path)) return new Map();
  const file = JSON.parse(readFileSync(path, 'utf8')) as PlatformFile;
  return new Map((file.platforms ?? []).map(p => [p.ein, p]));
}

export type Fit = 'target' | 'not_target';
export type DraftStatus = 'ready' | 'blocked' | 'none';

export interface Targeting {
  fit: Fit;
  fitReason: string;
  platform: string | null;
  platformConfirmed: boolean | null;
  /** ready: a confirmed target. blocked: a target whose mapping is not confirmed. none: not a target (a preview can still be rendered). */
  draftStatus: DraftStatus;
  draftReason: string | null;
}

/** Registry account kinds that are hospitals or health systems (ahrq:, ccn:). */
const isHospitalAccount = (accountId: string | null) => !!accountId && /^(ahrq|ccn):/.test(accountId);

export function targetingOf(f: Finding, link: NameLink, mapping: PlatformMapping | undefined): Targeting {
  if (mapping) {
    const fitReason = `Behavioral health platform (${mapping.platform}): the buyer the finding is for`;
    return mapping.confirmed
      ? { fit: 'target', fitReason, platform: mapping.platform, platformConfirmed: true, draftStatus: 'ready', draftReason: null }
      : {
        fit: 'target', fitReason, platform: mapping.platform, platformConfirmed: false, draftStatus: 'blocked',
        draftReason: `EIN ${f.ein} is mapped to ${mapping.platform} but not confirmed (${mapping.how}); an entity is only called theirs once it is`,
      };
  }
  const none = (fitReason: string): Targeting => ({ fit: 'not_target', fitReason, platform: null, platformConfirmed: null, draftStatus: 'none', draftReason: null });
  if (isHospitalAccount(link.accountId)) return none(`Hospital or health system (${link.accountName}): hospital systems hold the leverage in this finding, so it is not their problem`);
  if (f.band === '1-50') return none('Small independent group: the subject of the finding, not the buyer');
  return none('Not a mapped behavioral health platform; organization type is not a field in the file');
}
