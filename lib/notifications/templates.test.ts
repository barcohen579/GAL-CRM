import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFollowUpReminderEmail, buildDailyDigestEmail } from "./templates.ts";

test("buildFollowUpReminderEmail: subject includes the contact name", () => {
  const email = buildFollowUpReminderEmail({
    contactName: "מאיה כהן",
    reason: "ביקשה שנחזור אליה לגבי אימונים קבוצתיים",
    dueAtIso: "2026-09-10T07:00:00.000Z",
    recordUrl: "https://gal-crm.example.com/leads/abc-123",
  });
  assert.match(email.subject, /מאיה כהן/);
});

test("buildFollowUpReminderEmail: body includes name, reason, and a direct link — both HTML and text", () => {
  const email = buildFollowUpReminderEmail({
    contactName: "מאיה כהן",
    reason: "ביקשה שנחזור אליה לגבי אימונים קבוצתיים",
    dueAtIso: "2026-09-10T07:00:00.000Z",
    recordUrl: "https://gal-crm.example.com/leads/abc-123",
  });
  for (const body of [email.html, email.text]) {
    assert.match(body, /מאיה כהן/);
    assert.match(body, /ביקשה שנחזור אליה לגבי אימונים קבוצתיים/);
    assert.match(body, /https:\/\/gal-crm\.example\.com\/leads\/abc-123/);
  }
});

test("buildFollowUpReminderEmail: escapes HTML-special characters in user-provided text (never raw-injects into the HTML body)", () => {
  const email = buildFollowUpReminderEmail({
    contactName: '<script>alert("x")</script>',
    reason: "note with <b>tags</b> & an ampersand",
    dueAtIso: "2026-09-10T07:00:00.000Z",
    recordUrl: "https://gal-crm.example.com/leads/abc-123",
  });
  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<b>tags</b>"));
  assert.match(email.html, /&lt;script&gt;/);
});

test("buildFollowUpReminderEmail: never includes phone/email/financial data (only what was passed in)", () => {
  const email = buildFollowUpReminderEmail({
    contactName: "מאיה כהן",
    reason: "שיחה קצרה",
    dueAtIso: "2026-09-10T07:00:00.000Z",
    recordUrl: "https://gal-crm.example.com/leads/abc-123",
  });
  // The template has no code path that could ever emit a phone number,
  // an amount, or an email address — this just confirms the concrete
  // output for a typical input stays limited to name/reason/date/link.
  assert.ok(!/\d{3}-?\d{7}/.test(email.text), "should not contain anything phone-number-shaped");
  assert.ok(!email.text.includes("₪"), "should not contain any currency figure");
});

test("buildDailyDigestEmail: subject includes the item count", () => {
  const email = buildDailyDigestEmail(
    [
      { time: "10:00", contactName: "מאיה כהן", reason: "אימונים קבוצתיים", recordUrl: "https://x.test/leads/1" },
      { time: "13:30", contactName: "דנה לוי", reason: "אימון ניסיון", recordUrl: "https://x.test/leads/2" },
    ],
    "5 בספטמבר 2026"
  );
  assert.equal(email.subject, "המעקבים שלך להיום — 2");
});

test("buildDailyDigestEmail: every item's time/name/reason/link appears in both HTML and text", () => {
  const items = [
    { time: "10:00", contactName: "מאיה כהן", reason: "אימונים קבוצתיים", recordUrl: "https://x.test/leads/1" },
    { time: "13:30", contactName: "דנה לוי", reason: "לחזור לגבי אימון ניסיון", recordUrl: "https://x.test/customers/2" },
  ];
  const email = buildDailyDigestEmail(items, "5 בספטמבר 2026");
  for (const item of items) {
    for (const body of [email.html, email.text]) {
      assert.match(body, new RegExp(item.time));
      assert.match(body, new RegExp(item.contactName));
      assert.match(body, new RegExp(item.reason));
      assert.ok(body.includes(item.recordUrl));
    }
  }
});

test("buildDailyDigestEmail: zero items still produces valid content (caller decides whether to actually send)", () => {
  const email = buildDailyDigestEmail([], "5 בספטמבר 2026");
  assert.equal(email.subject, "המעקבים שלך להיום — 0");
});
