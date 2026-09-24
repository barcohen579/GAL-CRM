// Automatic Lead Follow-Up Escalation Loop — ACTIONABLE-VISIBILITY rule.
//
// Deliberately separate from, and must never be confused with, the
// ESCALATION eligibility rule in
// lib/notifications/reminder-logic.ts's isAutomaticEscalationEligible,
// which decides whether an escalation EMAIL is sent and is completely
// unchanged by this file. This module only decides whether the
// AUTOMATIC follow-up TASK itself should render as a second actionable
// row in a UI list — the row keeps existing, stays PENDING, and keeps
// driving the escalation/notification state exactly as before
// regardless of what this returns. Nothing here ever reads or writes
// the database; every caller already fetched its own PENDING rows the
// same way it always has, this just filters the in-memory result
// before rendering it.
//
// Rule: an AUTOMATIC, PENDING follow-up is suppressed from an
// actionable view whenever its own lead ALSO has another still-PENDING
// follow-up that is NOT itself AUTOMATIC (i.e. a manually scheduled
// one) — the same "a manual follow-up takes priority" principle the
// escalation cron already applies to EMAILS (see the spec's own §6),
// applied here to what Gal actually SEES as an open task, so she is
// never shown two competing rows for the same lead. The moment that
// manual follow-up is completed/cancelled (leaves PENDING) it simply
// stops appearing in whatever PENDING list the caller passed in, so
// the automatic one reappears on the very next render with no extra
// bookkeeping — same "live check every time, no stored suspended
// flag" design as isAutomaticEscalationEligible.
//
// A CANCELLED automatic follow-up (the WON/LOST auto-close from
// supabase/migrations/20260904161000_..._automatic_lead_followup_escalation.sql)
// never reaches this function at all in real usage: every call site
// already queries/filters to status = 'PENDING' before calling this,
// exactly as before this feature — WON/LOST exclusion from actionable
// views is that existing status filter, not a rule this function needs
// to know about. See supabase/tests/automatic_lead_followup_escalation.test.sql
// for the DB-level proof that WON/LOST flips the row to CANCELLED.

export type FollowUpVisibilityInfo = {
  source: string;
  status: string;
  /** The lead this follow-up belongs to, or null for a customer-linked
   *  follow-up (which can never be AUTOMATIC — the create_automatic_
   *  followup_for_new_lead() trigger only ever fires on leads — so a
   *  null leadId simply never gets suppressed). */
  leadId: string | null;
};

/** Returns the subset of `tasks` that should actually render as
 *  actionable — same items/order otherwise, just with suppressed
 *  AUTOMATIC rows removed. `getInfo` lets every call site's own query
 *  shape (a nested `lead.id`, a bare `lead_id` column, or a single-lead
 *  list that has no lead field at all) map itself in without this
 *  function caring which. */
export function filterActionableFollowUps<T>(
  tasks: T[],
  getInfo: (task: T) => FollowUpVisibilityInfo
): T[] {
  const leadsWithActiveManualFollowUp = new Set<string>();
  for (const task of tasks) {
    const info = getInfo(task);
    if (info.status === "PENDING" && info.source !== "AUTOMATIC" && info.leadId) {
      leadsWithActiveManualFollowUp.add(info.leadId);
    }
  }

  return tasks.filter((task) => {
    const info = getInfo(task);
    if (info.status !== "PENDING") return true; // only a PENDING automatic row is ever suppressed
    if (info.source !== "AUTOMATIC") return true; // never suppresses a manual (or AI_SUGGESTED) row
    if (!info.leadId) return true; // defensive — AUTOMATIC is always lead-linked
    return !leadsWithActiveManualFollowUp.has(info.leadId);
  });
}

// ------------------------------------------------------------------
// Lead Workflow V2 — single source of truth for "what is overdue" so the
// sidebar/nav badge (app/(app)/layout.tsx) and the /follow-ups page
// "באיחור" section can never disagree (audit finding: the badge used to
// fetch only overdue rows, so a future-dated MANUAL task could not
// suppress an overdue AUTOMATIC one there). Both callers must pass the
// FULL set of PENDING tasks.
// ------------------------------------------------------------------

export type OverdueCandidate = FollowUpVisibilityInfo & { dueAt: string };

/** The actionable, overdue subset of a FULL pending-task list. */
export function overdueActionableFollowUps<T>(
  tasks: T[],
  getInfo: (task: T) => OverdueCandidate,
  now: Date
): T[] {
  return filterActionableFollowUps(tasks, getInfo).filter(
    (task) => new Date(getInfo(task).dueAt).getTime() < now.getTime()
  );
}

/** User-facing title for a follow-up. The AUTOMATIC new-lead task's
 *  stored title is technical (pre-V2 rows say "מעקב אוטומטי לליד חדש");
 *  every summary view shows this plain-language label instead. */
export const AUTOMATIC_FOLLOW_UP_DISPLAY_TITLE = "ליד חדש — ליצור קשר ראשון";

export function followUpDisplayTitle(task: { source: string; title: string }): string {
  return task.source === "AUTOMATIC" ? AUTOMATIC_FOLLOW_UP_DISPLAY_TITLE : task.title;
}

/** Open leads (not WON/LOST) that have NO pending follow-up of any kind —
 *  they will never produce a reminder, so /follow-ups lists them under
 *  "לידים פתוחים בלי מעקב" for Gal to schedule. `pendingLeadIds` must be
 *  the lead ids of the FULL pending task set. */
export function openLeadsWithoutFollowUp<L extends { id: string; stage: string }>(
  leads: L[],
  pendingLeadIds: Iterable<string | null | undefined>
): L[] {
  const withPending = new Set<string>();
  for (const id of pendingLeadIds) if (id) withPending.add(id);
  return leads.filter((l) => l.stage !== "WON" && l.stage !== "LOST" && !withPending.has(l.id));
}
