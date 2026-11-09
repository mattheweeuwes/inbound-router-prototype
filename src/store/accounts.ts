// SQL for accounts and what hangs off them: claims, signals, rep assignments and the review queue.
import type { StatementSync } from 'node:sqlite';
import { allRows, getRow, tx, type Db } from '../db';

export interface AccountUpsert {
  id: string; name: string | null; segment: string | null; subsegment: string | null; domain: string | null;
  idsJson: string | null; firmographicsJson: string | null; at: string;
}

/** A rep's assignment history, for round-robin: the latest assignment ever, and the count since a cut-off. */
export type RepActivityRow = { owner: string; last: string | null; load: number };

export interface Assignment { owner: string; team: string; leadId: string; at: string }
/** A claim to make with the assignment: the account goes to `owner` if nobody owns it yet. */
export interface ClaimRequest { accountId: string; owner: string; signalDetail: string }

export function accountStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    upsert: p(`INSERT INTO accounts (id, name, segment, subsegment, domain, ids_json, firmographics_json, owner, intent_points, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, segment = excluded.segment, subsegment = excluded.subsegment,
        domain = COALESCE(excluded.domain, accounts.domain), ids_json = excluded.ids_json, firmographics_json = excluded.firmographics_json,
        updated_at = excluded.updated_at`),
    owner: p(`SELECT owner FROM accounts WHERE id = ?`),
    repActivity: p(`SELECT owner, MAX(at) AS last, COALESCE(SUM(at >= ?), 0) AS load FROM assignments WHERE owner IN (SELECT value FROM json_each(?)) GROUP BY owner`),
    assign: p(`INSERT INTO assignments (owner, team, lead_id, at) VALUES (?, ?, ?, ?)`),
    takeOwnership: p(`UPDATE accounts SET owner = ?, updated_at = ? WHERE id = ? AND owner IS NULL`),
    insertClaim: p(`INSERT INTO account_claims (lead_id, account_id, owner, at) VALUES (?, ?, ?, ?)`),
    insertSignal: p(`INSERT INTO account_signals (account_id, lead_id, type, detail, at) VALUES (?, ?, ?, ?, ?)`),
    // only when the account is still owned by the rep this lead put there; a later owner (or a mirror owner) is left alone
    releaseOwnership: p(`UPDATE accounts SET owner = NULL WHERE EXISTS
      (SELECT 1 FROM account_claims c WHERE c.lead_id = ? AND c.account_id = accounts.id AND c.owner = accounts.owner)`),
    deleteClaims: p(`DELETE FROM account_claims WHERE lead_id = ?`),
    deleteSignals: p(`DELETE FROM account_signals WHERE lead_id = ?`),
    deleteAssignments: p(`DELETE FROM assignments WHERE lead_id = ?`),
    addReview: p(`INSERT INTO review_queue (lead_id, reason, candidates_json, created_at, resolved) VALUES (?, ?, ?, ?, 0)`),
    deleteReview: p(`DELETE FROM review_queue WHERE lead_id = ?`),
    webIntentBetween: p(`SELECT COUNT(*) AS n FROM account_signals WHERE account_id = ? AND type = 'web_intent' AND at >= ? AND at <= ?`),
    webIntentAll: p(`SELECT COUNT(*) AS n FROM account_signals WHERE account_id = ? AND type = 'web_intent'`),
    setIntentPoints: p(`UPDATE accounts SET intent_points = ? WHERE id = ?`),
  };
  const count = (stmt: StatementSync, ...params: string[]) => Number(getRow<{ n: number }>(stmt, ...params)?.n ?? 0);

  return {
    upsert: (a: AccountUpsert) => { s.upsert.run(a.id, a.name, a.segment, a.subsegment, a.domain, a.idsJson, a.firmographicsJson, a.at, a.at); },
    /** The owner a rep claimed on an earlier lead. Seeded CRM owners are never stored here; they live in the mirror file. */
    claimedOwner: (accountId: string): string | null => getRow<{ owner: string | null }>(s.owner, accountId)?.owner ?? null,
    repActivity: (names: string[], since: string): RepActivityRow[] => allRows<RepActivityRow>(s.repActivity, since, JSON.stringify(names)),
    /**
     * Records a rep assignment and, when asked, claims the account in the same transaction. Returns whether the claim was
     * made: it is not when someone else claimed the account first.
     */
    assign(a: Assignment, claim: ClaimRequest | null): boolean {
      return tx(db, () => {
        s.assign.run(a.owner, a.team, a.leadId, a.at);
        if (!claim) return false;
        if (Number(s.takeOwnership.run(claim.owner, a.at, claim.accountId).changes) === 0) return false;
        s.insertClaim.run(a.leadId, claim.accountId, claim.owner, a.at);
        s.insertSignal.run(claim.accountId, a.leadId, 'claim', claim.signalDetail, a.at);
        return true;
      });
    },
    /** Undoes everything a lead wrote here, so a re-run starts clean: its claims (and the ownership they gave), signals, assignments and review item. */
    releaseLead(leadId: string) {
      s.releaseOwnership.run(leadId);
      s.deleteClaims.run(leadId);
      s.deleteSignals.run(leadId);
      s.deleteAssignments.run(leadId);
      s.deleteReview.run(leadId);
    },
    addReview: (leadId: string, reason: string, candidatesJson: string | null, at: string) => { s.addReview.run(leadId, reason, candidatesJson, at); },
    webIntentSignalsBetween: (accountId: string, since: string, until: string) => count(s.webIntentBetween, accountId, since, until),
    /** Records a web-intent signal and returns the account's signal count after it. */
    addWebIntentSignal(accountId: string, leadId: string, detail: string, at: string): number {
      s.insertSignal.run(accountId, leadId, 'web_intent', detail, at);
      return count(s.webIntentAll, accountId);
    },
    setIntentPoints: (accountId: string, points: number) => { s.setIntentPoints.run(points, accountId); },
  };
}

export type AccountStore = ReturnType<typeof accountStore>;
