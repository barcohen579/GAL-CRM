// Pure decision logic for "should THIS follow-up's reminder be sent
// right now" — no Supabase, no network, so every rule the task
// requires (future -> no, due -> yes, completed -> no, cancelled -> no,
// already-sent -> no duplicate, safe/bounded retry) is directly unit-
// testable in isolation, same "fetch/compute split" convention as
// lib/crm/marketing.ts. app/api/cron/follow-up-notifications/route.ts
// does the actual DB reads/claim/send and calls this for the decision.

import type { EmailSendResult } from "./email-provider.ts";

export type FollowUpTaskStatus = "PENDING" | "COMPLETED" | "CANCELLED";
export type ReminderDeliveryStatus = "PENDING" | "SENDING" | "SENT" | "FAILED";
export type FollowUpTaskSource = "MANUAL" | "AUTOMATIC" | "AI_SUGGESTED";

export type ReminderEligibilityInput = {
  taskStatus: FollowUpTaskStatus;
  /** AUTOMATIC-sourced follow-ups never go through this one-shot path —
   *  see isAutomaticEscalationEligible below for their own, repeating
   *  eligibility rule. Keeping the exclusion here (not just as a query
   *  filter in the route) makes it a directly testable rule like every
   *  other one in this function, and a second, independent guard on top
   *  of the query filter. */
  taskSource: FollowUpTaskSource;
  /** ISO timestamp — the follow-up's own due_at. */
  dueAtIso: string;
  deliveryStatus: ReminderDeliveryStatus;
  attemptCount: number;
  /** ISO timestamp of the last claim attempt, or null if never attempted. */
  lastAttemptedAtIso: string | null;
};

export type ReminderEligibilityConfig = {
  maxAttempts: number;
  backoffMinutes: number;
};

/** Whether this follow-up's reminder should be attempted right now,
 *  given `now`. Every rule here is deliberately explicit rather than
 *  folded into one boolean expression, so each one maps 1:1 to a named
 *  test case:
 *   - a COMPLETED or CANCELLED task never gets a reminder, regardless
 *     of its delivery row's own state.
 *   - a future due_at (> now) is never eligible yet.
 *   - SENT is terminal — never resent, no matter how many times this
 *     is called (the actual duplicate-prevention guarantee is still
 *     the DB claim in the route; this is the same rule expressed at
 *     the decision-logic level so it's independently testable).
 *   - SENDING means another attempt currently owns this delivery
 *     (or a previous run crashed mid-send without recording a
 *     terminal result) — never claimed again by ELIGIBILITY alone;
 *     the route's own claim step is a second, DB-level guard.
 *   - FAILED is retried only within maxAttempts, and only after
 *     backoffMinutes have passed since the last attempt — an
 *     unconditional immediate retry could hammer a genuinely down
 *     provider every single cron tick. */
export function isReminderEligible(
  input: ReminderEligibilityInput,
  now: Date,
  config: ReminderEligibilityConfig
): boolean {
  if (input.taskStatus !== "PENDING") return false;
  if (input.taskSource === "AUTOMATIC") return false;
  if (new Date(input.dueAtIso).getTime() > now.getTime()) return false;

  switch (input.deliveryStatus) {
    case "SENT":
      return false;
    case "SENDING":
      return false;
    case "PENDING":
      return true;
    case "FAILED": {
      if (input.attemptCount >= config.maxAttempts) return false;
      if (input.lastAttemptedAtIso) {
        const backoffUntilMs =
          new Date(input.lastAttemptedAtIso).getTime() + config.backoffMinutes * 60_000;
        if (now.getTime() < backoffUntilMs) return false;
      }
      return true;
    }
  }
}

export type DeliveryTerminalUpdate =
  | { status: "SENT"; sent_at: string; provider_message_id: string; last_error: null }
  | { status: "FAILED"; last_error: string };

/** Pure translation from "what the email provider actually returned"
 *  to "what the delivery row should be updated to" — the literal rule
 *  under test for "provider failure must never be falsely recorded as
 *  SENT": there is exactly one code path that can ever produce a SENT
 *  update, and it requires `result.ok === true` with a real
 *  provider_message_id already attached by the provider adapter (see
 *  EmailProvider's own contract — an adapter is not allowed to return
 *  `ok: true` without one). Every other case, including any provider
 *  bug that would return a malformed `ok: true` result, falls through
 *  to FAILED via the exhaustive switch below. `now` is injected (never
 *  read internally) so this stays deterministic and dependency-free. */
export function deliveryUpdateForSendResult(
  result: EmailSendResult,
  now: Date
): DeliveryTerminalUpdate {
  if (result.ok) {
    return {
      status: "SENT",
      sent_at: now.toISOString(),
      provider_message_id: result.providerMessageId,
      last_error: null,
    };
  }
  return { status: "FAILED", last_error: result.error };
}

// ------------------------------------------------------------------
// Automatic new-lead follow-up escalation (Automatic Lead Follow-Up
// Escalation Loop) — a REPEATING notification, unlike the one-shot
// individual reminder above: the same AUTOMATIC follow_up_tasks row
// (created once, at lead-creation time, by the
// create_automatic_followup_for_new_lead() trigger) can generate a
// fresh "still waiting" email once per eligible Israel calendar day,
// for as long as the lead is unresolved. The actual "never twice for
// the same lead/task + Israel day" guarantee is a DB unique constraint
// (follow_up_task_id, escalation_date) on lead_auto_escalation_deliveries
// — this function only decides whether the attempt is even worth
// making (so the route can skip a DB round-trip for obviously
// ineligible candidates), same "pure decision, DB enforces the actual
// dedupe" split as isReminderEligible/the reminder-deliveries claim.
// ------------------------------------------------------------------

export type LeadStageForEscalation = string; // "WON" | "LOST" | any other lead_stage value

export type EscalationEligibilityInput = {
  taskStatus: FollowUpTaskStatus;
  taskSource: FollowUpTaskSource;
  /** ISO timestamp — the automatic follow-up's own due_at (its Day-0
   *  target date). */
  dueAtIso: string;
  leadStage: LeadStageForEscalation;
  /** True when this lead has ANY OTHER still-PENDING follow-up whose
   *  source is NOT AUTOMATIC (i.e. a manually scheduled one) — per the
   *  spec's §6 "manual follow-ups take priority": a manual follow-up
   *  suspends the automatic daily escalation entirely while it exists,
   *  with no separate stored "suspended" state needed — this is simply
   *  re-checked live on every cron tick, so escalation resumes on its
   *  own the moment the manual one is completed/cancelled (still no
   *  WON/LOST, still PENDING here), with no backdating. */
  hasCompetingManualFollowUp: boolean;
};

/** Whether an automatic escalation attempt for this follow-up is worth
 *  making right now, given `now` and whether `now`'s real Israel
 *  calendar day is an eligible one (caller computes that once per cron
 *  tick via isFollowUpBusinessDay — a single fact for the whole run,
 *  not per-candidate, so it is injected rather than recomputed here).
 *  Every rule maps 1:1 to a spec requirement:
 *   - only a still-PENDING, AUTOMATIC-sourced task is ever considered
 *     (a MANUAL/AI_SUGGESTED task never enters this path; a COMPLETED/
 *     CANCELLED one — including one auto-cancelled by WON/LOST — is
 *     never eligible again, regardless of source).
 *   - WON/LOST always stops the loop (belt-and-suspenders: the
 *     authoritative stop is the transactional auto-cancel in
 *     change_lead_stage()/convert_lead_to_won(), which flips the task
 *     to CANCELLED and already fails the status check above — this is
 *     a second, independently testable guard against a stale read).
 *   - a future due_at (Day-0 hasn't arrived yet) is never eligible.
 *   - Friday/Saturday never generate an occurrence — the caller-
 *     supplied `isBusinessDayToday` is the single source of truth for
 *     that, matching this repo's "inject now, never read it internally"
 *     convention.
 *   - a competing manual follow-up suspends escalation entirely. */
export function isAutomaticEscalationEligible(
  input: EscalationEligibilityInput,
  now: Date,
  isBusinessDayToday: boolean
): boolean {
  if (input.taskStatus !== "PENDING") return false;
  if (input.taskSource !== "AUTOMATIC") return false;
  if (input.leadStage === "WON" || input.leadStage === "LOST") return false;
  if (new Date(input.dueAtIso).getTime() > now.getTime()) return false;
  if (!isBusinessDayToday) return false;
  if (input.hasCompetingManualFollowUp) return false;
  return true;
}
