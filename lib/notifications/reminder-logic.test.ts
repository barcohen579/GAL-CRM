import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWhatsAppUrl,
  deliveryOutcomeForSendResult,
  reminderIdempotencyKey,
  reminderKindForSource,
  reminderSkipReason,
} from "./reminder-logic.ts";

const NOW = new Date("2026-09-23T07:30:00.000Z");

test("AUTOMATIC tasks use the new-lead reminder; MANUAL (and anything else) use the manual reminder", () => {
  assert.equal(reminderKindForSource("AUTOMATIC"), "NEW_LEAD");
  assert.equal(reminderKindForSource("MANUAL"), "MANUAL");
  assert.equal(reminderKindForSource("AI_SUGGESTED"), "MANUAL");
});

test("reminderSkipReason: a still-pending task of an open lead is sent", () => {
  assert.equal(reminderSkipReason({ taskStatus: "PENDING", leadStage: "NEW", hasParent: true }), null);
  assert.equal(reminderSkipReason({ taskStatus: "PENDING", leadStage: null, hasParent: true }), null); // customer task
});

test("reminderSkipReason: completed/cancelled tasks, resolved leads and missing tasks are never sent", () => {
  assert.ok(reminderSkipReason({ taskStatus: "COMPLETED", leadStage: "NEW", hasParent: true }));
  assert.ok(reminderSkipReason({ taskStatus: "CANCELLED", leadStage: "NEW", hasParent: true }));
  assert.ok(reminderSkipReason({ taskStatus: "PENDING", leadStage: "WON", hasParent: true }));
  assert.ok(reminderSkipReason({ taskStatus: "PENDING", leadStage: "LOST", hasParent: true }));
  assert.ok(reminderSkipReason({ taskStatus: null, leadStage: null, hasParent: false }));
  assert.ok(reminderSkipReason({ taskStatus: "PENDING", leadStage: null, hasParent: false }));
});

test("the idempotency key is stable per delivery and distinct across deliveries", () => {
  assert.equal(reminderIdempotencyKey("abc"), reminderIdempotencyKey("abc"));
  assert.notEqual(reminderIdempotencyKey("abc"), reminderIdempotencyKey("abd"));
  assert.ok(reminderIdempotencyKey("00000000-0000-0000-0000-000000000000").length <= 256);
});

test("deliveryOutcomeForSendResult: confirmed success -> SENT with the provider id", () => {
  const outcome = deliveryOutcomeForSendResult({ ok: true, providerMessageId: "re_1" }, NOW);
  assert.deepEqual(outcome, { status: "SENT", sentAtIso: NOW.toISOString(), providerMessageId: "re_1", note: null });
});

test("deliveryOutcomeForSendResult: provider/network failure -> FAILED, never SENT", () => {
  const outcome = deliveryOutcomeForSendResult({ ok: false, error: "timeout" }, NOW);
  assert.deepEqual(outcome, { status: "FAILED", error: "timeout" });
});

test("deliveryOutcomeForSendResult: 'idempotency key already used' -> SENT (an earlier attempt reached the provider)", () => {
  const outcome = deliveryOutcomeForSendResult({ ok: false, error: "409", alreadyAccepted: true }, NOW);
  assert.equal(outcome.status, "SENT");
});

test("buildWhatsAppUrl: valid Israeli phone formats produce a wa.me link", () => {
  assert.equal(buildWhatsAppUrl("0501234567"), "https://wa.me/972501234567");
  assert.equal(buildWhatsAppUrl("+972-50-123-4567"), "https://wa.me/972501234567");
  assert.equal(buildWhatsAppUrl("050 123 4567"), "https://wa.me/972501234567");
});

test("buildWhatsAppUrl: missing or invalid phone -> no WhatsApp button", () => {
  assert.equal(buildWhatsAppUrl(null), null);
  assert.equal(buildWhatsAppUrl(undefined), null);
  assert.equal(buildWhatsAppUrl(""), null);
  assert.equal(buildWhatsAppUrl("123"), null);
});
