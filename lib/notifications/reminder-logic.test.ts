import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isReminderEligible,
  deliveryUpdateForSendResult,
  isAutomaticEscalationEligible,
  buildFollowUpReason,
} from "./reminder-logic.ts";

const NOW = new Date("2026-09-10T10:00:00.000Z");
const CONFIG = { maxAttempts: 5, backoffMinutes: 30 };

function base(overrides: Partial<Parameters<typeof isReminderEligible>[0]> = {}) {
  return {
    taskStatus: "PENDING" as const,
    taskSource: "MANUAL" as const,
    dueAtIso: "2026-09-10T09:00:00.000Z", // already due
    deliveryStatus: "PENDING" as const,
    attemptCount: 0,
    lastAttemptedAtIso: null,
    ...overrides,
  };
}

test("a future follow-up is NOT eligible", () => {
  const input = base({ dueAtIso: "2026-09-10T11:00:00.000Z" }); // 1h from now
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

test("a due (past due_at), never-attempted (PENDING) follow-up IS eligible", () => {
  const input = base();
  assert.equal(isReminderEligible(input, NOW, CONFIG), true);
});

test("a due_at exactly equal to now IS eligible (due, not future)", () => {
  const input = base({ dueAtIso: NOW.toISOString() });
  assert.equal(isReminderEligible(input, NOW, CONFIG), true);
});

test("a COMPLETED task is never eligible, even if its delivery row is PENDING and overdue", () => {
  const input = base({ taskStatus: "COMPLETED" });
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

test("a CANCELLED task is never eligible", () => {
  const input = base({ taskStatus: "CANCELLED" });
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

test("an already-SENT delivery is never eligible again (no duplicate)", () => {
  const input = base({ deliveryStatus: "SENT" });
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

test("a SENDING (in-flight/claimed) delivery is not eligible for a second concurrent claim", () => {
  const input = base({ deliveryStatus: "SENDING" });
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

test("a FAILED delivery within the backoff window is not yet eligible for retry", () => {
  const input = base({
    deliveryStatus: "FAILED",
    attemptCount: 1,
    lastAttemptedAtIso: "2026-09-10T09:45:00.000Z", // 15 min ago, backoff is 30 min
  });
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

test("a FAILED delivery past the backoff window IS eligible for retry", () => {
  const input = base({
    deliveryStatus: "FAILED",
    attemptCount: 1,
    lastAttemptedAtIso: "2026-09-10T09:00:00.000Z", // 60 min ago, backoff is 30 min
  });
  assert.equal(isReminderEligible(input, NOW, CONFIG), true);
});

test("a FAILED delivery that already exhausted maxAttempts is never retried again", () => {
  const input = base({
    deliveryStatus: "FAILED",
    attemptCount: 5,
    lastAttemptedAtIso: "2026-09-10T01:00:00.000Z", // long past backoff
  });
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

test("a FAILED delivery that has never actually been attempted (defensive: null lastAttemptedAtIso) is eligible", () => {
  const input = base({ deliveryStatus: "FAILED", attemptCount: 0, lastAttemptedAtIso: null });
  assert.equal(isReminderEligible(input, NOW, CONFIG), true);
});

test("an AUTOMATIC-sourced follow-up is never eligible for the one-shot reminder, even if otherwise due — it uses its own repeating escalation path", () => {
  const input = base({ taskSource: "AUTOMATIC" });
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

// ------------------------------------------------------------------
// isAutomaticEscalationEligible — the repeating daily-escalation rule.
// ------------------------------------------------------------------

function escalationBase(overrides: Partial<Parameters<typeof isAutomaticEscalationEligible>[0]> = {}) {
  return {
    taskStatus: "PENDING" as const,
    taskSource: "AUTOMATIC" as const,
    dueAtIso: "2026-09-10T06:00:00.000Z", // already due
    leadStage: "NEW",
    hasCompetingManualFollowUp: false,
    ...overrides,
  };
}

test("a due, PENDING, AUTOMATIC follow-up on an eligible business day IS eligible for escalation", () => {
  assert.equal(isAutomaticEscalationEligible(escalationBase(), NOW, true), true);
});

test("escalation is never eligible on a non-business day (Friday/Saturday), regardless of due_at", () => {
  assert.equal(isAutomaticEscalationEligible(escalationBase(), NOW, false), false);
});

test("a MANUAL-sourced task never enters the escalation path", () => {
  const input = escalationBase({ taskSource: "MANUAL" });
  assert.equal(isAutomaticEscalationEligible(input, NOW, true), false);
});

test("a COMPLETED or CANCELLED automatic task is never eligible again", () => {
  assert.equal(isAutomaticEscalationEligible(escalationBase({ taskStatus: "COMPLETED" }), NOW, true), false);
  assert.equal(isAutomaticEscalationEligible(escalationBase({ taskStatus: "CANCELLED" }), NOW, true), false);
});

test("a WON lead's automatic follow-up is never eligible (belt-and-suspenders on top of the DB auto-cancel)", () => {
  const input = escalationBase({ leadStage: "WON" });
  assert.equal(isAutomaticEscalationEligible(input, NOW, true), false);
});

test("a LOST lead's automatic follow-up is never eligible", () => {
  const input = escalationBase({ leadStage: "LOST" });
  assert.equal(isAutomaticEscalationEligible(input, NOW, true), false);
});

test("a future Day-0 due_at is not yet eligible", () => {
  const input = escalationBase({ dueAtIso: "2026-09-10T11:00:00.000Z" }); // 1h from now
  assert.equal(isAutomaticEscalationEligible(input, NOW, true), false);
});

test("a competing manual follow-up on the same lead suspends the automatic escalation entirely", () => {
  const input = escalationBase({ hasCompetingManualFollowUp: true });
  assert.equal(isAutomaticEscalationEligible(input, NOW, true), false);
});

test("a lead still INTERESTED (not WON/LOST) keeps its automatic escalation eligible — ordinary stage progression never stops the loop on its own", () => {
  const input = escalationBase({ leadStage: "INTERESTED" });
  assert.equal(isAutomaticEscalationEligible(input, NOW, true), true);
});

test("'One current MANUAL follow-up per Lead': an active PENDING MANUAL follow-up prevents automatic escalation, same rule as any other competing manual", () => {
  // create_manual_follow_up_for_lead guarantees at most one PENDING
  // MANUAL follow-up per lead, but this eligibility rule itself doesn't
  // need to know that — hasCompetingManualFollowUp just means "does
  // this lead currently have ANY other PENDING non-automatic follow-up",
  // true whether there is one or (pre-invariant) several.
  const input = escalationBase({ hasCompetingManualFollowUp: true });
  assert.equal(isAutomaticEscalationEligible(input, NOW, true), false);
});

test("a MANUAL follow-up superseded by a newer one (now CANCELLED) can never send its own reminder email, even if its delivery row is still PENDING/overdue", () => {
  // Exactly the state create_manual_follow_up_for_lead leaves the OLD
  // MANUAL follow-up in once superseded: status flips to CANCELLED but
  // its original follow_up_reminder_deliveries row is left exactly as
  // it was (never deleted, never touched) — isReminderEligible's own
  // taskStatus check is what stops it from ever being sent.
  const input = base({ taskStatus: "CANCELLED", taskSource: "MANUAL", deliveryStatus: "PENDING" });
  assert.equal(isReminderEligible(input, NOW, CONFIG), false);
});

// ------------------------------------------------------------------
// deliveryUpdateForSendResult — "never mark SENT until the provider
// actually confirms" as a directly-testable pure rule.
// ------------------------------------------------------------------

test("deliveryUpdateForSendResult: a confirmed provider success produces a SENT update with the provider's message id", () => {
  const update = deliveryUpdateForSendResult(
    { ok: true, providerMessageId: "msg_abc123" },
    NOW
  );
  assert.equal(update.status, "SENT");
  assert.equal((update as { provider_message_id: string }).provider_message_id, "msg_abc123");
  assert.equal((update as { sent_at: string }).sent_at, NOW.toISOString());
});

test("deliveryUpdateForSendResult: a provider failure produces FAILED, never SENT", () => {
  const update = deliveryUpdateForSendResult(
    { ok: false, error: "Resend API error (HTTP 422): invalid recipient" },
    NOW
  );
  assert.equal(update.status, "FAILED");
  assert.equal((update as { last_error: string }).last_error, "Resend API error (HTTP 422): invalid recipient");
});

test("deliveryUpdateForSendResult: a network/timeout-style failure also produces FAILED, never SENT", () => {
  const update = deliveryUpdateForSendResult(
    { ok: false, error: "Resend API request timed out after 10000ms" },
    NOW
  );
  assert.equal(update.status, "FAILED");
});

// ------------------------------------------------------------------
// buildFollowUpReason — "what drives the email": the exact text Gal
// sees explaining why she needs to contact this Lead/Customer now.
// ------------------------------------------------------------------

test("buildFollowUpReason: title and notes are joined with an em dash when both are present", () => {
  assert.equal(
    buildFollowUpReason("לחזור אליה", "ביקשה שאחזור ביום ראשון אחרי 16:00"),
    "לחזור אליה — ביקשה שאחזור ביום ראשון אחרי 16:00"
  );
});

test("buildFollowUpReason: title alone when notes is null — never a dangling separator", () => {
  assert.equal(buildFollowUpReason("לחזור אליה מחר", null), "לחזור אליה מחר");
});

test("buildFollowUpReason: title alone when notes is an empty string", () => {
  assert.equal(buildFollowUpReason("לחזור אליה מחר", ""), "לחזור אליה מחר");
});

test("buildFollowUpReason: reflects the CURRENT MANUAL follow-up's own title/notes — a superseded one's text is never mixed in (the caller only ever passes the still-PENDING row's own fields)", () => {
  // Simulates exactly the ליד בדיקה-shaped case: an old, superseded
  // MANUAL follow-up with a generic title and no notes, and the new,
  // current one with Gal's own real context — the email must be built
  // from the current one's fields alone.
  const supersededOldReason = buildFollowUpReason("מעקב מול ליד בדיקה", null);
  const currentReason = buildFollowUpReason("ליד בדיקה", "גל גל גל");
  assert.equal(currentReason, "ליד בדיקה — גל גל גל");
  assert.notEqual(currentReason, supersededOldReason);
});
