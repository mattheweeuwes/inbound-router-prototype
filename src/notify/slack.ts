// Slack Block Kit payloads. Dry-run only: the payload is built, stored on the lead and written to out/slack/.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Brief } from '../brief';
import type { Ctx } from '../context';
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
      { type: 'context', elements: [{ type: 'mrkdwn', text: i.synthetic ? ':test_tube: *SYNTHETIC* lead from the prototype fixtures' : 'Live lead' }] },
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
      { type: 'context', elements: [{ type: 'mrkdwn', text: `The run did not finish, so the lead may have no owner and no HubSpot record. ${i.synthetic ? ':test_tube: *SYNTHETIC* lead from the prototype fixtures' : 'Live lead'}` }] },
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
      { type: 'context', elements: [{ type: 'mrkdwn', text: i.synthetic ? ':test_tube: *SYNTHETIC* lead from the prototype fixtures' : 'Live lead' }] },
    ],
  };
}

export function recordSlack(ctx: Ctx, leadId: string, p: SlackPayload, at: string) {
  const dir = join(ctx.cfg.outDir, 'slack');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${at.slice(0, 10)}.jsonl`), JSON.stringify({ leadId, at, ...p }) + '\n');
}
