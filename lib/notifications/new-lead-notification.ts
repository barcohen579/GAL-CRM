// Immediate "new lead" email notification — the send-side counterpart
// to the existing next-day AUTOMATIC follow-up escalation
// (lib/notifications/reminder-logic.ts /
// app/api/cron/follow-up-notifications/route.ts). Deliberately entirely
// separate from that system: this fires at most once, synchronously,
// in the SAME request that just durably persisted a genuinely NEW
// Meta/Zapier lead (app/api/zapier/facebook-leads/route.ts,
// app/api/meta/leadgen-webhook/route.ts) — it shares no tables, no
// templates, and no cron with the next-day reminder/escalation/digest
// system, and must never be confused with or replace it. If this
// immediate send fails, the AUTOMATIC follow-up (already created by the
// create_automatic_followup_for_new_lead() DB trigger on every new
// Lead, independent of this file) remains the safety net that still
// surfaces the lead to Gal the next business day.
//
// Dedup: relies ENTIRELY on the existing ingestion idempotency
// (meta_lead_ingestions.leadgen_id uniqueness + the claim/PROCESSED
// state machine — see lib/meta/ingest.ts). shouldSendNewLeadNotification
// below is a second, independently-testable guard expressing that same
// rule at the decision level — the same "pure predicate, DB enforces
// the real guarantee" split this codebase already uses for
// isReminderEligible / isAutomaticEscalationEligible.
import type { EmailProvider } from "./email-provider.ts";
import { buildNewLeadNotificationEmail, type NewLeadNotificationInput } from "./templates.ts";
import type { ProcessOutcome } from "../meta/ingest.ts";

/** Only a genuinely first-time-processed ingestion may ever trigger the
 *  immediate email — "duplicate" (this facebookLeadId was already seen,
 *  whether from a Zapier retry, a Vercel network retry, or the lead
 *  legitimately arriving twice), "in_progress_elsewhere" (another
 *  concurrent delivery owns it), and "failed" (nothing was persisted)
 *  must never send a second/spurious email. */
export function shouldSendNewLeadNotification(
  outcome: ProcessOutcome
): outcome is Extract<ProcessOutcome, { outcome: "processed" }> {
  return outcome.outcome === "processed";
}

// ------------------------------------------------------------------
// Bounded retry for a FAILED (or never-attempted) immediate email —
// used by app/api/cron/follow-up-notifications/route.ts's
// processNewLeadNotificationRetries, NOT by the ingestion routes
// themselves (their one synchronous attempt is unconditional —
// shouldSendNewLeadNotification above is what gates THAT). This is the
// safety net for "the lead was genuinely new, but Resend/the network
// hiccuped on the first attempt" — a retried facebookLeadId delivery
// never reaches this path at all (it resolves to "duplicate" upstream,
// per shouldSendNewLeadNotification's own doc comment); this only ever
// re-attempts the SAME already-PROCESSED meta_lead_ingestions row.
//
// Pure predicate, no I/O — same "pure decision, DB enforces the real
// guarantee" split as isReminderEligible/isAutomaticEscalationEligible
// in reminder-logic.ts. The actual "never claimed twice" guarantee is
// the caller's own atomic compare-and-swap UPDATE on
// notification_attempt_count (see the cron route), not this function.
// ------------------------------------------------------------------

export type NewLeadNotificationRetryEligibilityInput = {
  /** meta_lead_ingestions.status for this row. */
  ingestionStatus: string;
  /** meta_lead_ingestions.notification_sent_at — null until confirmed sent. */
  notificationSentAt: string | null;
  /** meta_lead_ingestions.notification_attempt_count. */
  notificationAttemptCount: number;
};

export type NewLeadNotificationRetryConfig = {
  maxAttempts: number;
};

/** Whether this ingestion row's immediate email is worth (re)attempting
 *  right now:
 *   - only a genuinely, durably PROCESSED lead is ever eligible — a
 *     "duplicate"/"failed"/still-"PROCESSING" ingestion row never has a
 *     real Contact/Lead to notify about (mirrors
 *     shouldSendNewLeadNotification's own "processed" gate, just read
 *     back from persisted state instead of a fresh ProcessOutcome).
 *   - already-confirmed-SENT is terminal — never resent, no matter how
 *     many times this is called.
 *   - bounded by maxAttempts so a permanently broken email provider can
 *     never retry forever; once notification_attempt_count reaches it,
 *     this row is left FAILED for good (the next-day AUTOMATIC
 *     follow-up escalation remains the safety net). No separate backoff
 *     window is needed on top of this: this cron route only ticks once
 *     every ~2 hours (see vercel.json), which already spaces retries
 *     out generously. */
export function isNewLeadNotificationRetryEligible(
  input: NewLeadNotificationRetryEligibilityInput,
  config: NewLeadNotificationRetryConfig
): boolean {
  if (input.ingestionStatus !== "PROCESSED") return false;
  if (input.notificationSentAt) return false;
  if (input.notificationAttemptCount >= config.maxAttempts) return false;
  return true;
}

export type NotificationRecordResult =
  | { status: "SENT"; sentAt: string; providerMessageId: string }
  | { status: "FAILED"; error: string };

export type SendNewLeadNotificationParams = {
  provider: EmailProvider;
  recipient: string;
  lead: NewLeadNotificationInput;
  /** Persists the outcome (in practice: an UPDATE of
   *  meta_lead_ingestions.notification_sent_at/notification_error for
   *  this ingestion row). Injected so this function needs no
   *  Supabase/DB dependency of its own and stays unit-testable with a
   *  plain fake — same DI convention as EmailProvider/PageTokenDeriver
   *  elsewhere in this codebase. */
  recordNotification: (result: NotificationRecordResult) => Promise<void>;
};

// Never throws: a caller can always safely await this immediately after
// persisting a lead, with zero risk to the already-committed
// Contact/Lead/Touchpoint — mirrors EmailProvider.send's own "never
// throws" contract, and this file's own module comment on failure
// safety. Any failure (a provider error, or even recordNotification
// itself failing) is reported and swallowed here; it can never roll
// back the lead or affect the caller's HTTP response.
export async function sendNewLeadNotification(params: SendNewLeadNotificationParams): Promise<void> {
  const { provider, recipient, lead, recordNotification } = params;
  try {
    const email = buildNewLeadNotificationEmail(lead);
    const result = await provider.send({
      to: recipient,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });

    if (result.ok) {
      await recordNotification({
        status: "SENT",
        sentAt: new Date().toISOString(),
        providerMessageId: result.providerMessageId,
      });
    } else {
      console.error(
        JSON.stringify({ step: "new_lead_notification_send_failed", error: result.error })
      );
      await recordNotification({ status: "FAILED", error: result.error });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error sending new-lead notification";
    console.error(JSON.stringify({ step: "new_lead_notification_unexpected_error", message }));
    try {
      await recordNotification({ status: "FAILED", error: message });
    } catch {
      // Recording the failure itself failed — nothing more to do; never
      // let this bubble up and affect the caller's response or the
      // already-persisted lead.
    }
  }
}
