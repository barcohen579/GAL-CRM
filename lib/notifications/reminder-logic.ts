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

export type ReminderEligibilityInput = {
  taskStatus: FollowUpTaskStatus;
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
