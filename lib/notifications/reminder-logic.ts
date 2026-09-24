// Pure decision logic for the Lead Workflow V2 reminder emails — no
// Supabase, no network, so every rule is directly unit-testable.
//
// V2 has exactly two routine reminder emails, both ONE-SHOT per
// follow_up_tasks row and both delivered through the same
// follow_up_reminder_deliveries ledger:
//   - NEW_LEAD: the AUTOMATIC task every new lead gets (10:00 Israel on
//     the next Sun-Thu after creation).
//   - MANUAL:   a follow-up Gal scheduled that is still open at 10:00
//     Israel on the next Sun-Thu after its due date.
// WHEN a reminder becomes eligible is stored per delivery row
// (remind_at, computed by SQL follow_up_reminder_at(); TS mirror:
// lib/crm/timezone.ts followUpReminderAtIso). WHICH rows get claimed,
// and the concurrency/retry/stale-SENDING rules, live in SQL
// claim_due_follow_up_reminders(). This file only decides what to do
// with a row that has already been claimed.

import type { EmailSendResult } from "./email-provider.ts";
import { normalizePhone } from "../meta/normalize.ts";

export type FollowUpTaskStatus = "PENDING" | "COMPLETED" | "CANCELLED";
export type FollowUpTaskSource = "MANUAL" | "AUTOMATIC" | "AI_SUGGESTED";
export type ReminderKind = "NEW_LEAD" | "MANUAL";

export function reminderKindForSource(source: FollowUpTaskSource): ReminderKind {
  return source === "AUTOMATIC" ? "NEW_LEAD" : "MANUAL";
}

/** Why an already-claimed reminder must NOT be sent after all (the task
 *  or lead changed between the claim query and this check), or null
 *  when it should be sent. The SQL claim already filters these; this is
 *  the second, independently testable guard against a stale read. */
export function reminderSkipReason(input: {
  taskStatus: FollowUpTaskStatus | null;
  leadStage: string | null;
  hasParent: boolean;
}): string | null {
  if (input.taskStatus === null) return "task not found";
  if (input.taskStatus !== "PENDING") return "task no longer pending";
  if (!input.hasParent) return "task has no linked lead or customer";
  if (input.leadStage === "WON" || input.leadStage === "LOST") return "lead already resolved";
  return null;
}

/** Stable per-delivery provider idempotency key: every attempt for the
 *  same delivery row reuses it, so Resend never delivers it twice
 *  within its 24h idempotency window. */
export function reminderIdempotencyKey(deliveryId: string): string {
  return `gal-crm-follow-up-reminder-${deliveryId}`;
}

export type DeliveryOutcome =
  | { status: "SENT"; sentAtIso: string; providerMessageId: string | null; note: string | null }
  | { status: "FAILED"; error: string };

/** "What the provider returned" -> "what the delivery row becomes".
 *  SENT only on a confirmed acceptance (a real message id), or when the
 *  provider reports this delivery's idempotency key was already used by
 *  an earlier attempt (that attempt reached the provider — re-sending
 *  under a new key would be the duplicate we must avoid). Everything
 *  else is FAILED (bounded retry in SQL). */
export function deliveryOutcomeForSendResult(result: EmailSendResult, now: Date): DeliveryOutcome {
  if (result.ok) {
    return { status: "SENT", sentAtIso: now.toISOString(), providerMessageId: result.providerMessageId, note: null };
  }
  if (result.alreadyAccepted) {
    return {
      status: "SENT",
      sentAtIso: now.toISOString(),
      providerMessageId: null,
      note: "provider reported this delivery's idempotency key as already used — treated as sent",
    };
  }
  return { status: "FAILED", error: result.error };
}

/** The WhatsApp deep link for a Lead/Customer phone, or null when there
 *  is no usable phone on file (then no WhatsApp button is shown). Reuses
 *  normalizePhone (lib/meta/normalize.ts) — the same Israel-aware
 *  normalization used for Meta contact matching. This only builds a
 *  link Gal can tap; the CRM never sends WhatsApp messages itself. */
export function buildWhatsAppUrl(phone: string | null | undefined): string | null {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return `https://wa.me/${normalized}`;
}
