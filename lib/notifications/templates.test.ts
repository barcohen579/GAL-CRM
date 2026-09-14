import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildManualFollowUpReminderEmail,
  buildAutomaticFollowUpReminderEmail,
  buildDailyDigestEmail,
  buildNewLeadNotificationEmail,
  type NewLeadNotificationInput,
} from "./templates.ts";

// ------------------------------------------------------------------
// buildManualFollowUpReminderEmail
// ------------------------------------------------------------------

const baseManualInput = {
  leadName: "מאיה כהן",
  title: "לחזור אליה מחר",
  notes: "ביקשה שנחזור אליה לגבי אימונים קבוצתיים",
  interestedServiceLabels: ["אימון קבוצתי"],
  dueAtIso: "2026-09-10T07:00:00.000Z",
  recordUrl: "https://gal-crm.example.com/leads/abc-123",
  whatsappUrl: "https://wa.me/972501234567",
};

test("buildManualFollowUpReminderEmail: subject uses the new wording and en dash", () => {
  const email = buildManualFollowUpReminderEmail(baseManualInput);
  assert.equal(email.subject, "תזכורת למעקב – מאיה כהן");
});

test("buildManualFollowUpReminderEmail: title + notes are shown separately, never concatenated", () => {
  const email = buildManualFollowUpReminderEmail(baseManualInput);
  for (const body of [email.html, email.text]) {
    assert.match(body, /לחזור אליה מחר/);
    assert.match(body, /הערה אחרונה:/);
    assert.match(body, /ביקשה שנחזור אליה לגבי אימונים קבוצתיים/);
    // The old format joined title and notes with " — " on one line —
    // confirm that joined string never appears as a single unit.
    assert.ok(!body.includes("לחזור אליה מחר — ביקשה שנחזור אליה לגבי אימונים קבוצתיים"));
  }
});

test("buildManualFollowUpReminderEmail: a title identical to the lead name is not shown as redundant context", () => {
  const email = buildManualFollowUpReminderEmail({
    ...baseManualInput,
    title: "מאיה כהן",
    notes: null,
  });
  // The greeting line itself contains the name once ("הגיע הזמן לחזור
  // אל מאיה כהן.") — assert the name does not appear a SECOND time as
  // its own separate line, which is what a redundant title would add.
  const nameOccurrences = (email.text.match(/מאיה כהן/g) ?? []).length;
  assert.equal(nameOccurrences, 2, "expected only the h1/subject occurrence and the greeting occurrence");
});

test("buildManualFollowUpReminderEmail: a title with real context beyond the lead name IS shown", () => {
  const email = buildManualFollowUpReminderEmail({ ...baseManualInput, notes: null });
  assert.match(email.text, /לחזור אליה מחר/);
});

test("buildManualFollowUpReminderEmail: no notes -> no 'הערה אחרונה' label at all, not an empty one", () => {
  const email = buildManualFollowUpReminderEmail({ ...baseManualInput, notes: null });
  for (const body of [email.html, email.text]) {
    assert.ok(!body.includes("הערה אחרונה"));
  }
});

test("buildManualFollowUpReminderEmail: renders a single interested service in Hebrew", () => {
  const email = buildManualFollowUpReminderEmail(baseManualInput);
  for (const body of [email.html, email.text]) {
    assert.match(body, /מתעניינת ב: אימון קבוצתי/);
  }
});

test("buildManualFollowUpReminderEmail: renders multiple interested services, comma-joined", () => {
  const email = buildManualFollowUpReminderEmail({
    ...baseManualInput,
    interestedServiceLabels: ["אימון קבוצתי", "ליווי תזונתי"],
  });
  for (const body of [email.html, email.text]) {
    assert.match(body, /מתעניינת ב: אימון קבוצתי, ליווי תזונתי/);
  }
});

test("buildManualFollowUpReminderEmail: no interested services -> the field is omitted entirely", () => {
  const email = buildManualFollowUpReminderEmail({ ...baseManualInput, interestedServiceLabels: [] });
  for (const body of [email.html, email.text]) {
    assert.ok(!body.includes("מתעניינת ב"));
  }
});

test("buildManualFollowUpReminderEmail: never renders a raw service enum value", () => {
  // Nothing in this function's own logic could emit an enum value —
  // it only ever joins whatever strings the caller passed as labels.
  // This asserts the concrete typical-input output stays free of the
  // enum spelling, as a regression guard on the call site's own
  // responsibility to resolve labels first.
  const email = buildManualFollowUpReminderEmail(baseManualInput);
  assert.ok(!email.text.includes("GROUP_TRAINING"));
  assert.ok(!email.html.includes("GROUP_TRAINING"));
});

test("buildManualFollowUpReminderEmail: due date/time is rendered under 'מועד המעקב'", () => {
  const email = buildManualFollowUpReminderEmail(baseManualInput);
  for (const body of [email.html, email.text]) {
    assert.match(body, /מועד המעקב:/);
  }
});

test("buildManualFollowUpReminderEmail: a valid WhatsApp URL renders a WhatsApp action", () => {
  const email = buildManualFollowUpReminderEmail(baseManualInput);
  for (const body of [email.html, email.text]) {
    assert.match(body, /פתיחת WhatsApp/);
    assert.ok(body.includes("https://wa.me/972501234567"));
  }
});

test("buildManualFollowUpReminderEmail: never prints a raw local-format phone number — only the pre-built wa.me URL it was given", () => {
  // This function never receives a raw phone at all (only a finished
  // wa.me URL, see ManualFollowUpReminderInput) — this is a regression
  // guard confirming that contract stays true for a typical input.
  const email = buildManualFollowUpReminderEmail(baseManualInput);
  for (const body of [email.html, email.text]) {
    assert.ok(!/\b0\d{8,9}\b/.test(body), "must never contain anything shaped like a raw local-format Israeli phone number");
  }
});

test("buildManualFollowUpReminderEmail: null whatsappUrl -> no WhatsApp button, CRM link still present", () => {
  const email = buildManualFollowUpReminderEmail({ ...baseManualInput, whatsappUrl: null });
  for (const body of [email.html, email.text]) {
    assert.ok(!body.includes("פתיחת WhatsApp"));
    assert.ok(!body.includes("wa.me"));
    assert.match(body, /פתיחת הליד ב-CRM/);
    assert.ok(body.includes(baseManualInput.recordUrl));
  }
});

test("buildManualFollowUpReminderEmail: escapes HTML-special characters (never raw-injects into the HTML body)", () => {
  const email = buildManualFollowUpReminderEmail({
    ...baseManualInput,
    leadName: '<script>alert("x")</script>',
    notes: "note with <b>tags</b> & an ampersand",
  });
  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<b>tags</b>"));
  assert.match(email.html, /&lt;script&gt;/);
});

// ------------------------------------------------------------------
// buildAutomaticFollowUpReminderEmail — the safety-net template
// ------------------------------------------------------------------

const baseAutomaticInput = {
  leadName: "דנה לוי",
  interestedServiceLabels: ["ליווי תזונתי"],
  recordUrl: "https://gal-crm.example.com/leads/def-456",
  whatsappUrl: "https://wa.me/972509876543",
};

test("buildAutomaticFollowUpReminderEmail: subject uses the dedicated safety-net wording", () => {
  const email = buildAutomaticFollowUpReminderEmail(baseAutomaticInput);
  assert.equal(email.subject, "תזכורת לליד פתוח – דנה לוי");
});

test("buildAutomaticFollowUpReminderEmail: body explains no active manual follow-up, never mentions AUTOMATIC or the trigger's generic title", () => {
  const email = buildAutomaticFollowUpReminderEmail(baseAutomaticInput);
  for (const body of [email.html, email.text]) {
    assert.match(body, /עדיין פתוחה ואין כרגע מעקב ידני פעיל/);
    assert.match(body, /זה הזמן לבדוק אם צריך לחזור אליה/);
    assert.ok(!body.includes("AUTOMATIC"));
    assert.ok(!body.includes("מעקב אוטומטי לליד חדש"));
  }
});

test("buildAutomaticFollowUpReminderEmail: never displays a fake 'הערה אחרונה' — there is no human note to show", () => {
  const email = buildAutomaticFollowUpReminderEmail(baseAutomaticInput);
  for (const body of [email.html, email.text]) {
    assert.ok(!body.includes("הערה אחרונה"));
  }
});

test("buildAutomaticFollowUpReminderEmail: renders interested services when available", () => {
  const email = buildAutomaticFollowUpReminderEmail(baseAutomaticInput);
  for (const body of [email.html, email.text]) {
    assert.match(body, /מתעניינת ב: ליווי תזונתי/);
  }
});

test("buildAutomaticFollowUpReminderEmail: omits interested services when there are none", () => {
  const email = buildAutomaticFollowUpReminderEmail({ ...baseAutomaticInput, interestedServiceLabels: [] });
  for (const body of [email.html, email.text]) {
    assert.ok(!body.includes("מתעניינת ב"));
  }
});

test("buildAutomaticFollowUpReminderEmail: includes both WhatsApp and CRM actions when a phone is on file", () => {
  const email = buildAutomaticFollowUpReminderEmail(baseAutomaticInput);
  for (const body of [email.html, email.text]) {
    assert.match(body, /פתיחת WhatsApp/);
    assert.match(body, /פתיחת הליד ב-CRM/);
  }
});

test("buildAutomaticFollowUpReminderEmail: null whatsappUrl omits the WhatsApp action entirely", () => {
  const email = buildAutomaticFollowUpReminderEmail({ ...baseAutomaticInput, whatsappUrl: null });
  for (const body of [email.html, email.text]) {
    assert.ok(!body.includes("פתיחת WhatsApp"));
    assert.match(body, /פתיחת הליד ב-CRM/);
  }
});

// ------------------------------------------------------------------
// buildDailyDigestEmail — unchanged by this task, unaffected by the
// above (kept as a regression guard).
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
// buildNewLeadNotificationEmail
// ------------------------------------------------------------------

const baseNewLeadInput: NewLeadNotificationInput = {
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
};

test("buildNewLeadNotificationEmail: subject clearly indicates a new Meta lead", () => {
  const email = buildNewLeadNotificationEmail(baseNewLeadInput);
  assert.match(email.subject, /^ליד חדש נכנס מ-Meta/);
  assert.match(email.subject, /מאיה כהן/);
});

// Guards against exactly the class of bug a terminal's RTL/BiDi
// rendering can visually suggest but that never actually exists in the
// source: this asserts the LOGICAL Unicode code point sequence the
// subject is built from, byte for byte, not just "the right substrings
// appear somewhere" (the two regex checks above). Built from explicit
// \uXXXX escapes for the Hebrew prefix — deliberately not typed as a
// literal Hebrew string in this one assertion — so a reviewer/diff tool
// rendering this file right-to-left cannot mask a reordering bug here
// the way it could in the source file itself.
test("buildNewLeadNotificationEmail: subject is EXACTLY the required Hebrew/Latin string at the source Unicode level, not just visually", () => {
  const email = buildNewLeadNotificationEmail(baseNewLeadInput);

  // "ליד חדש נכנס מ-Meta" spelled out via \uXXXX escapes, left to right
  // in source order: ל י ד (space) ח ד ש (space) נ כ נ ס (space) מ - M e t a
  const expectedPrefix =
    "ליד" + // ליד
    " " +
    "חדש" + // חדש
    " " +
    "נכנס" + // נכנס
    " " +
    "מ" + // מ
    "-" + // -
    "Meta";

  assert.equal(expectedPrefix, "ליד חדש נכנס מ-Meta"); // sanity: escapes match the literal exactly
  assert.equal(email.subject, `${expectedPrefix} — ${baseNewLeadInput.fullName}`);
  assert.equal(email.subject, "ליד חדש נכנס מ-Meta — מאיה כהן");

  // The separator between the fixed prefix and the lead's name must be
  // a real em dash (U+2014), never an en dash (U+2013) or a bare
  // hyphen-minus (U+002D). Checked via an explicit code point, not a
  // literal dash character in this source file, so this assertion
  // itself can't be silently miscopied.
  assert.ok(email.subject.includes(String.fromCodePoint(0x2014)));
  assert.ok(!email.subject.includes(String.fromCodePoint(0x2013)));

  // No stray bidi control characters anywhere in the subject
  // (U+200E/U+200F LRM/RLM, U+202A-U+202E embedding/override,
  // U+2066-U+2069 isolates) — confirms the subject is built purely
  // from ordinary characters, with any RTL/BiDi presentation left
  // entirely to the mail client's own Unicode bidi algorithm rather
  // than baked into the string.
  const bidiControlCodePoints = [
    0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  for (const codePoint of bidiControlCodePoints) {
    assert.ok(
      !email.subject.includes(String.fromCodePoint(codePoint)),
      `subject must not contain bidi control character U+${codePoint.toString(16).toUpperCase()}`
    );
  }
});

test("buildNewLeadNotificationEmail: includes full name, phone, source, timestamp and attribution in both HTML and text", () => {
  const email = buildNewLeadNotificationEmail(baseNewLeadInput);
  for (const body of [email.html, email.text]) {
    assert.match(body, /מאיה כהן/);
    assert.ok(body.includes("0501234567"));
    assert.match(body, /Meta \/ Facebook Lead Ads/);
    assert.match(body, /קמפיין קיץ/);
    assert.match(body, /טופס ליד/);
    assert.match(body, /מודעה א/);
    assert.ok(body.includes(baseNewLeadInput.recordUrl));
    assert.ok(body.includes(baseNewLeadInput.whatsappUrl!));
  }
});

test("buildNewLeadNotificationEmail: omits phone/email/attribution lines that are null rather than rendering them empty", () => {
  const email = buildNewLeadNotificationEmail({
    ...baseNewLeadInput,
    phone: null,
    email: null,
    campaignName: null,
    formName: null,
    adName: null,
    whatsappUrl: null,
  });
  assert.ok(!email.text.includes("טלפון:"));
  assert.ok(!email.text.includes("אימייל:"));
  assert.ok(!email.text.includes("קמפיין:"));
  assert.ok(!email.html.includes("wa.me"));
});
