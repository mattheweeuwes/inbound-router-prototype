// Slack Block Kit payloads. Dry-run only: the payload is built, stored on the lead and written to out/slack/.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Brief } from '../brief';
import type { Ctx } from '../context';
import { cutNote, REVIEW_ROWS_LISTED, TOP_ROWS, type DigestRow, type DigestSummary, type ListBatch } from '../lists';
import type { Route, Score } from '../schema';

export interface SlackPayload { channel: string; text: string; blocks: unknown[]; dryRun: true }

export function slackChannel(route: Route): string {
  if (route.action === 'rep_alert' || (route.action === 'attach_to_existing' && !route.alertSuppressed)) return `@${route.owner}`;
  if (route.action === 'review') return '#revops-review';
  if (route.action === 'competitor_flag') return '#marketing';
  return `#leads-${route.team.toLowerCase()}`;
}

export interface SlackInput { brief: Brief; score: Score; route: Route; timeToRouteMs: number; synthetic: boolean; afterHours: boolean }

export function buildSlackPayload(i: SlackInput): SlackPayload {
  const { brief, score, route } = i;
  const header = `Tier ${score.tier} (${score.total}) | ${route.team} | ${route.action.replace(/_/g, ' ')}`;
  const sla = route.slaDueAt ? `${route.slaMinutes} min${route.rule === 'R8' && route.action === 'team_queue' ? ' (business)' : ''}, due ${route.slaDueAt}${i.afterHours ? ' (after hours)' : ''}` : 'none';
  const f = (label: string, value: string) => ({ type: 'mrkdwn', text: `*${label}*\n${value.slice(0, 1800)}` });
  // the account and deal lines (decisions 25 and 26) in a section of their own, so the first stays within Slack's ten fields
  const account = [brief.enterprise, brief.referral, brief.alsoIn].filter((x): x is string => !!x).map(line => f(labelOf(line), stripLabel(line)));
  return {
    channel: slackChannel(route),
    text: `${header}: ${brief.person}`,
    dryRun: true,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header.slice(0, 150) } },
      { type: 'section', fields: [
        f('Person', brief.person),
        f('Organization', brief.org),
        ...(brief.rates ? [f('Their rates', brief.rates)] : []),
        f('Why now', brief.whyNow + (brief.quote ? `\n> ${brief.quote}` : '')),
        f('Owner and SLA', `${route.owner}\nSLA ${sla}`),
        f('Time to route', `${(i.timeToRouteMs / 1000).toFixed(1)} s`),
        f('Routing', `${route.rule}: ${route.reason}`),
      ] },
      ...(account.length ? [{ type: 'section', fields: account }] : []),
    ],
  };
}

/** A brief line's "Label: " prefix, which becomes the field's label, and the line without it. */
const labelOf = (line: string) => line.slice(0, Math.max(0, line.indexOf(':')));
const stripLabel = (line: string) => line.replace(/^[^:]+:\s*/, '');

/** Where sales leadership sees enterprise demand without reading every alert. */
export const ENTERPRISE_CHANNEL = '#enterprise-deals';

export interface EnterpriseNoteInput {
  person: string;
  /** the account's name */
  org: string;
  /** the brief's Enterprise line, or its Deal size line when only a cue put the lead here */
  enterprise: string | null;
  /** the account meets the enterprise definition; false when a deal-size cue alone sent the lead to a named rep */
  isEnterprise: boolean;
  route: Route;
  door: string;
  synthetic: boolean;
}

/**
 * The short note to the enterprise deals channel on the first enterprise lead of an account in 30 days (decision 25): who
 * came in, the account's fact line and the cues, and who has it. Every word is from the brief or the route. An account
 * that is not enterprise by the definition is never called one: its note is headed by the cue.
 */
export function buildEnterpriseNote(i: EnterpriseNoteInput): SlackPayload {
  const header = `${i.isEnterprise ? 'Enterprise lead' : 'Deal-size cue'}: ${i.org}`;
  const first = i.isEnterprise ? 'First enterprise lead from this account in 30 days.' : 'First lead with a deal-size cue from this account in 30 days.';
  const lines = [
    `${i.person} (${i.door})`,
    ...(i.enterprise ? [stripLabel(i.enterprise)] : []),
    `${i.route.owner} has it (${i.route.rule}, ${i.route.action.replace(/_/g, ' ')}${i.route.slaMinutes ? `, ${i.route.slaMinutes} min SLA` : ''})`,
  ];
  return {
    channel: ENTERPRISE_CHANNEL,
    text: `${header}: ${i.person}`,
    dryRun: true,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${header.slice(0, 150)}*\n${lines.join('\n').slice(0, 2800)}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: first }] },
    ],
  };
}

export interface FailureInput { leadId: string; source: string; receivedAt: string; attempts: number; error: string; synthetic: boolean }

/**
 * The alert RevOps gets when a lead is given up after its last failed run. It says what is known without the pipeline's
 * output (which never finished): the door, when it arrived, how often it was tried and the last error.
 */
export function buildFailureAlert(i: FailureInput): SlackPayload {
  const header = `Lead not processed after ${i.attempts} attempt${i.attempts === 1 ? '' : 's'}`;
  const f = (label: string, value: string) => ({ type: 'mrkdwn', text: `*${label}*\n${value.slice(0, 1800)}` });
  return {
    channel: '#revops-review',
    text: `${header}: ${i.source} lead ${i.leadId}`,
    dryRun: true,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header } },
      { type: 'section', fields: [
        f('Lead', i.leadId),
        f('Door', i.source),
        f('Received', i.receivedAt),
        f('Last error', i.error),
      ] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'The run did not finish, so the lead may have no owner and no HubSpot record.' }] },
    ],
  };
}

export interface DoubtFollowUpInput {
  /** where the follow-up goes: the channel the alert went to, or #revops-review */
  channel: string;
  person: string;
  org: string;
  /** the sentence from doubtAfterAlert in src/route.ts */
  sentence: string;
  /** the prospect's own words, quoted as in the alert; nothing here is written by the model */
  quote: string | null;
  synthetic: boolean;
}

/** The follow-up to a doubt the model raised after the alert: the same lead, what was flagged, and that RevOps is checking. */
export function buildDoubtFollowUp(i: DoubtFollowUpInput): SlackPayload {
  const header = 'Follow-up: RevOps is checking this lead';
  const f = (label: string, value: string) => ({ type: 'mrkdwn', text: `*${label}*\n${value.slice(0, 1800)}` });
  return {
    channel: i.channel,
    text: `${header}: ${i.person}`,
    dryRun: true,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header } },
      { type: 'section', fields: [
        f('Person', i.person),
        f('Organization', i.org),
        f('What changed', i.sentence + (i.quote ? `\n> ${i.quote}` : '')),
      ] },
    ],
  };
}

export interface ListDigestInput {
  batch: ListBatch;
  /** the team's display name, or 'RevOps review' */
  teamLabel: string;
  channel: string;
  summary: DigestSummary;
  synthetic: boolean;
}

const TIER_ORDER = ['A', 'B', 'C', 'D', 'X', 'pending'];
const countLine = (counts: Record<string, number>, order: string[] = []) =>
  Object.entries(counts).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b))
    .map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(' · ');

/**
 * One list's digest for one team (decision 24), in place of one alert per row: how many rows it has for the team, counts by
 * tier and by action, the top rows by score with their booth notes, how many more, the list's repeats and unknown
 * organizations, and the earliest SLA due among the team's items. Every figure is counted by code from stored rows.
 */
export function buildListDigest(i: ListDigestInput): SlackPayload {
  const { batch, summary } = i;
  const header = `${batch.list}: ${summary.rows} row${summary.rows === 1 ? '' : 's'} for ${i.teamLabel}`;
  const f = (label: string, value: string) => ({ type: 'mrkdwn', text: `*${label}*\n${value.slice(0, 1800)}` });
  const line = (r: DigestRow) => `${r.enterprise ? '*Enterprise* · ' : ''}${r.tier ?? '?'} ${r.score ?? '?'} · ${r.name}${r.title ? `, ${r.title}` : ''} · ${r.org ?? r.companyTyped ?? 'unknown organization'}${r.note ? ` · "${cutNote(r.note)}"` : ''}`;
  const top = summary.top.map(line).join('\n') + (summary.more ? `\n...and ${summary.more} more` : '');
  return {
    channel: i.channel,
    text: `${header} (list digest)`,
    dryRun: true,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header.slice(0, 150) } },
      { type: 'section', fields: [
        f('List', `${batch.list}: ${batch.rows} row${batch.rows === 1 ? '' : 's'} in this upload, ${summary.rows} here`),
        f('By tier', countLine(summary.byTier, TIER_ORDER)),
        f('By action', countLine(summary.byAction)),
        f('Earliest SLA due', summary.earliestSlaDueAt ?? 'none'),
        f('Repeats attached', `${batch.repeatsAttached} in the list`),
        f('Unknown organizations', `${batch.unknownOrgs} in the list`),
      ] },
      { type: 'section', text: { type: 'mrkdwn', text: `*Top ${Math.min(summary.top.length, TOP_ROWS)} by score*\n${top}`.slice(0, 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'One digest per list and team; each row keeps its own route, SLA and CRM task.' }] },
    ],
  };
}

/** The RevOps digest for a list's review rows: every row listed (up to REVIEW_ROWS_LISTED) with the company as typed and the reason, in place of one alert each. */
export function buildReviewDigest(i: ListDigestInput & { rows: DigestRow[] }): SlackPayload {
  const { batch, rows } = i;
  const header = `${batch.list}: ${rows.length} row${rows.length === 1 ? '' : 's'} need a person`;
  const listed = rows.slice(0, REVIEW_ROWS_LISTED).map(r =>
    `${r.name}${r.title ? `, ${r.title}` : ''} · said "${r.companyTyped ?? r.org ?? 'no company'}" · ${(r.reviewReason ?? 'review').replace(/_/g, ' ')}`);
  const more = rows.length > REVIEW_ROWS_LISTED ? `\n...and ${rows.length - REVIEW_ROWS_LISTED} more` : '';
  const f = (label: string, value: string) => ({ type: 'mrkdwn', text: `*${label}*\n${value.slice(0, 1800)}` });
  return {
    channel: i.channel,
    text: `${header} (list digest)`,
    dryRun: true,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header.slice(0, 150) } },
      { type: 'section', fields: [
        f('List', `${batch.list}: ${batch.rows} row${batch.rows === 1 ? '' : 's'} in this upload`),
        f('Unknown organizations', `${batch.unknownOrgs} in the list`),
        f('Earliest SLA due', i.summary.earliestSlaDueAt ?? 'none'),
        f('Repeats attached', `${batch.repeatsAttached} in the list`),
      ] },
      { type: 'section', text: { type: 'mrkdwn', text: `*Waiting for RevOps*\n${listed.join('\n')}${more}`.slice(0, 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Each row is its own review item in Needs a person.' }] },
    ],
  };
}

export function recordSlack(ctx: Ctx, leadId: string, p: SlackPayload, at: string) {
  const dir = join(ctx.cfg.outDir, 'slack');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${at.slice(0, 10)}.jsonl`), JSON.stringify({ leadId, at, ...p }) + '\n');
}
