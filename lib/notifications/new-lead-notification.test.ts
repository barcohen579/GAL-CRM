import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldSendNewLeadNotification,
  sendNewLeadNotification,
  isNewLeadNotificationRetryEligible,
  type NotificationRecordResult,
} from "./new-lead-notification.ts";
import type { EmailProvider, EmailMessage, EmailSendResult } from "./email-provider.ts";
import type { ProcessOutcome } from "../meta/ingest.ts";
import type { NewLeadNotificationInput } from "./templates.ts";

// ------------------------------------------------------------------
// shouldSendNewLeadNotification — the dedup guard. This is the rule
// that must hold for "same facebookLeadId sent twice never sends a
// second email": every non-"processed" outcome (which is exactly what
// a retried/duplicated facebookLeadId produces — see
// lib/meta/zapier-ingest.test.ts and lib/meta/ingest.test.ts's own
// dedup coverage) must be false.
// ------------------------------------------------------------------

test("shouldSendNewLeadNotification: true only for a genuinely first-time-processed outcome", () => {
  assert.equal(
    shouldSendNewLeadNotification({
      outcome: "processed",
      ingestionId: "i1",
      contactId: "c1",
      leadId: "l1",
      touchpointId: "t1",
    }),
    true
  );
});

test("shouldSendNewLeadNotification: false for duplicate/in_progress_elsewhere/failed — never a second email", () => {
  const nonProcessed: ProcessOutcome[] = [
    { outcome: "duplicate", ingestionId: "i1", contactId: "c1", leadId: "l1", touchpointId: "t1" },
    { outcome: "in_progress_elsewhere", ingestionId: "i1" },
    { outcome: "failed", ingestionId: "i1", errorMessage: "boom" },
  ];
  for (const outcome of nonProcessed) {
    assert.equal(shouldSendNewLeadNotification(outcome), false);
  }
});

// ------------------------------------------------------------------
// sendNewLeadNotification
// ------------------------------------------------------------------

function fakeLead(overrides: Partial<NewLeadNotificationInput> = {}): NewLeadNotificationInput {
  return {
    fullName: "מאיה כהן",
    phone: "0501234567",
    email: "maya@example.com",
    source: "Meta / Facebook Lead Ads",
    receivedAtIso: "2026-09-14T08:15:00.000Z",
    campaignName: "קמפיין קיץ",
    formName: "טופס ליד",
    adName: "מודעה א",
    recordUrl: "https://gal-crm.example.com/leads/abc-123",
    whatsappUrl: "https://wa.me/972501234567",
    ...overrides,
  };
}

function fakeProvider(result: EmailSendResult): EmailProvider & { calls: EmailMessage[] } {
  const calls: EmailMessage[] = [];
  return {
    calls,
    async send(message) {
      calls.push(message);
      return result;
    },
  };
}

test("sendNewLeadNotification: a successful send records SENT with the provider's message id", async () => {
  const provider = fakeProvider({ ok: true, providerMessageId: "resend-msg-1" });
  const recorded: NotificationRecordResult[] = [];

  await sendNewLeadNotification({
    provider,
    recipient: "gal@example.com",
    lead: fakeLead(),
    recordNotification: async (result) => {
      recorded.push(result);
    },
  });

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].to, "gal@example.com");
  assert.match(provider.calls[0].subject, /^ליד חדש נכנס מ-Meta/);

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, "SENT");
  if (recorded[0].status === "SENT") {
    assert.equal(recorded[0].providerMessageId, "resend-msg-1");
  }
});

test("sendNewLeadNotification: a provider failure records FAILED and never throws", async () => {
  const provider = fakeProvider({ ok: false, error: "Resend API error (HTTP 500): down" });
  const recorded: NotificationRecordResult[] = [];

  await assert.doesNotReject(
    sendNewLeadNotification({
      provider,
      recipient: "gal@example.com",
      lead: fakeLead(),
      recordNotification: async (result) => {
        recorded.push(result);
      },
    })
  );

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, "FAILED");
  if (recorded[0].status === "FAILED") {
    assert.match(recorded[0].error, /down/);
  }
});

test("sendNewLeadNotification: the lead is never affected by an email failure — this function itself never throws even if the provider throws", async () => {
  const throwingProvider: EmailProvider = {
    async send() {
      throw new Error("network exploded");
    },
  };
  const recorded: NotificationRecordResult[] = [];

  await assert.doesNotReject(
    sendNewLeadNotification({
      provider: throwingProvider,
      recipient: "gal@example.com",
      lead: fakeLead(),
      recordNotification: async (result) => {
        recorded.push(result);
      },
    })
  );

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, "FAILED");
});

test("sendNewLeadNotification: never throws even if recordNotification itself fails", async () => {
  const provider = fakeProvider({ ok: true, providerMessageId: "resend-msg-2" });

  await assert.doesNotReject(
    sendNewLeadNotification({
      provider,
      recipient: "gal@example.com",
      lead: fakeLead(),
      recordNotification: async () => {
        throw new Error("db write failed");
      },
    })
  );
});

// ------------------------------------------------------------------
// isNewLeadNotificationRetryEligible — the FAILED-notification retry
// path's own dedup/bound guard, exercised by
// app/api/cron/follow-up-notifications's processNewLeadNotificationRetries.
// Task requirements A-E below.
// ------------------------------------------------------------------

const RETRY_CONFIG = { maxAttempts: 5 };

// A. first send succeeds -> never retried
test("A. a PROCESSED row whose first send already succeeded (notification_sent_at set) is never retried", () => {
  assert.equal(
    isNewLeadNotificationRetryEligible(
      { ingestionStatus: "PROCESSED", notificationSentAt: "2026-09-14T08:00:00.000Z", notificationAttemptCount: 1 },
      RETRY_CONFIG
    ),
    false
  );
});

// B. first send fails -> eligible for retry
test("B. a PROCESSED row whose first send failed (notification_sent_at still null) IS eligible for retry", () => {
  assert.equal(
    isNewLeadNotificationRetryEligible(
      { ingestionStatus: "PROCESSED", notificationSentAt: null, notificationAttemptCount: 1 },
      RETRY_CONFIG
    ),
    true
  );
});

// A fresh row that never had ANY notification attempt yet (defensive —
// in practice the synchronous first attempt always runs first) is also
// eligible, same rule.
test("a never-attempted PROCESSED row (attempt count 0) is eligible", () => {
  assert.equal(
    isNewLeadNotificationRetryEligible(
      { ingestionStatus: "PROCESSED", notificationSentAt: null, notificationAttemptCount: 0 },
      RETRY_CONFIG
    ),
    true
  );
});

// C. retry succeeds -> becomes SENT and is never sent again. The
// "becomes SENT" half is sendNewLeadNotification's own contract
// (already covered above); this covers the "never sent again" half —
// once notification_sent_at is set (whether by the first attempt or a
// later retry), eligibility is false regardless of attempt count.
test("C. once a retry succeeds and sets notification_sent_at, the same row is never eligible again", () => {
  assert.equal(
    isNewLeadNotificationRetryEligible(
      { ingestionStatus: "PROCESSED", notificationSentAt: "2026-09-14T10:00:00.000Z", notificationAttemptCount: 3 },
      RETRY_CONFIG
    ),
    false
  );
});

// D. repeated webhook for same facebookLeadId still creates no
// duplicate lead/email — a "duplicate"/"in_progress_elsewhere"/"failed"
// ingestion outcome never even reaches this retry path (shouldSendNewLeadNotification
// already covers the immediate-send side above); this covers the OTHER
// half: even if such a row were somehow queried, its ingestion status
// is never "PROCESSED", so it is never eligible here either — a second,
// independent guard against the same class of bug.
test("D. a row whose ingestion status is not PROCESSED (duplicate/failed/in-flight) is never eligible, regardless of notification state", () => {
  for (const ingestionStatus of ["DUPLICATE_IGNORED", "FAILED", "PROCESSING", "PENDING"]) {
    assert.equal(
      isNewLeadNotificationRetryEligible(
        { ingestionStatus, notificationSentAt: null, notificationAttemptCount: 0 },
        RETRY_CONFIG
      ),
      false,
      `expected ${ingestionStatus} to be ineligible`
    );
  }
});

// E. permanent email failure does not affect the lead itself — this
// retry system only ever reads/writes meta_lead_ingestions'
// notification_* columns; it has no code path that touches
// contacts/leads/touchpoints at all, so once attempts are exhausted the
// row simply stops being retried (the lead stays exactly as durably
// PROCESSED as it always was — the next-day AUTOMATIC follow-up
// escalation remains the safety net for actually reaching Gal).
test("E. once attempts are exhausted the row permanently stops being eligible (bounded, never retries forever) — the underlying ingestion status is untouched", () => {
  const exhausted = {
    ingestionStatus: "PROCESSED", // ingestion itself remains successfully PROCESSED — untouched by notification failures
    notificationSentAt: null,
    notificationAttemptCount: 5,
  };
  assert.equal(isNewLeadNotificationRetryEligible(exhausted, RETRY_CONFIG), false);

  // One below the bound is still eligible — confirms this is a real
  // boundary check, not an always-false stub.
  assert.equal(
    isNewLeadNotificationRetryEligible({ ...exhausted, notificationAttemptCount: 4 }, RETRY_CONFIG),
    true
  );
});
