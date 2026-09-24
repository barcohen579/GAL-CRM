import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildManualFollowUpReminderEmail,
  buildNewLeadReminderEmail,
  type ManualFollowUpReminderInput,
  type NewLeadReminderInput,
} from "./templates.ts";

function newLead(overrides: Partial<NewLeadReminderInput> = {}): NewLeadReminderInput {
  return {
    leadName: "דנה כהן",
    phone: "050-1234567",
    stageLabel: "חדש",
    interestedServiceLabels: ["אימון קבוצתי", "ליווי תזונתי"],
    sourceLabel: "פרסומת במטא",
    leadCreatedAtIso: "2026-09-22T11:00:00.000Z",
    latestConversation: null,
    recordUrl: "https://crm.example.test/leads/L1",
    whatsappUrl: "https://wa.me/972501234567",
    ...overrides,
  };
}

function manual(overrides: Partial<ManualFollowUpReminderInput> = {}): ManualFollowUpReminderInput {
  return {
    name: "דנה כהן",
    phone: "050-1234567",
    stageLabel: "נוצר קשר",
    isCustomer: false,
    interestedServiceLabels: ["אימון אישי"],
    title: "לחזור אליה לגבי מחירים",
    notes: "ביקשה שיחה אחרי 17:00",
    dueAtIso: "2026-09-22T14:00:00.000Z",
    latestConversation: { outcomeLabel: "ביקשה מחירים / פרטים", note: "שלחתי מחירון", atIso: "2026-09-21T10:00:00.000Z" },
    recordUrl: "https://crm.example.test/leads/L1",
    whatsappUrl: "https://wa.me/972501234567",
    ...overrides,
  };
}

test("new-lead reminder: exact subject 'תזכורת לליד חדש — {name}'", () => {
  assert.equal(buildNewLeadReminderEmail(newLead()).subject, "תזכורת לליד חדש — דנה כהן");
});

test("manual reminder: exact subject 'מעקב שטרם הושלם — {name}'", () => {
  assert.equal(buildManualFollowUpReminderEmail(manual()).subject, "מעקב שטרם הושלם — דנה כהן");
});

test("the two subjects are distinct", () => {
  assert.notEqual(
    buildNewLeadReminderEmail(newLead()).subject.split(" — ")[0],
    buildManualFollowUpReminderEmail(manual()).subject.split(" — ")[0]
  );
});

test("new-lead reminder includes name, phone, stage, services, source and the CRM link", () => {
  const { html, text } = buildNewLeadReminderEmail(newLead());
  for (const body of [html, text]) {
    assert.ok(body.includes("דנה כהן"));
    assert.ok(body.includes("050-1234567"));
    assert.ok(body.includes("חדש"));
    assert.ok(body.includes("אימון קבוצתי, ליווי תזונתי"));
    assert.ok(body.includes("פרסומת במטא"));
    assert.ok(body.includes("https://crm.example.test/leads/L1"));
  }
});

test("manual reminder includes what to do, the note, the stage, services and the latest conversation note", () => {
  const { html, text } = buildManualFollowUpReminderEmail(manual());
  for (const body of [html, text]) {
    assert.ok(body.includes("לחזור אליה לגבי מחירים"));
    assert.ok(body.includes("ביקשה שיחה אחרי 17:00"));
    assert.ok(body.includes("נוצר קשר"));
    assert.ok(body.includes("אימון אישי"));
    assert.ok(body.includes("ביקשה מחירים / פרטים"));
    assert.ok(body.includes("שלחתי מחירון"));
  }
});

test("WhatsApp button only when a valid phone link exists; the CRM link is always present", () => {
  const withWa = buildNewLeadReminderEmail(newLead());
  assert.ok(withWa.html.includes("https://wa.me/972501234567"));
  assert.ok(withWa.html.includes("פתיחת WhatsApp"));

  const withoutWa = buildNewLeadReminderEmail(newLead({ whatsappUrl: null, phone: null }));
  assert.ok(!withoutWa.html.includes("wa.me"));
  assert.ok(!withoutWa.html.includes("WhatsApp"));
  assert.ok(!withoutWa.text.includes("טלפון"));
  assert.ok(withoutWa.html.includes("פתיחת הליד ב-CRM"));
});

test("optional rows are omitted, never rendered empty", () => {
  const { text } = buildNewLeadReminderEmail(
    newLead({ interestedServiceLabels: [], sourceLabel: null, latestConversation: null })
  );
  assert.ok(!text.includes("מתעניינת ב"));
  assert.ok(!text.includes("מקור"));
  assert.ok(!text.includes("שיחה אחרונה"));

  const m = buildManualFollowUpReminderEmail(manual({ notes: null, latestConversation: null }));
  assert.ok(!m.text.includes("הערה:"));
  assert.ok(!m.text.includes("שיחה אחרונה"));
});

test("customer follow-up reminder links to the customer and says so", () => {
  const { html, text } = buildManualFollowUpReminderEmail(
    manual({ isCustomer: true, stageLabel: null, recordUrl: "https://crm.example.test/customers/C1" })
  );
  assert.ok(html.includes("פתיחת הלקוחה ב-CRM"));
  assert.ok(text.includes("שלב: לקוחה"));
});

test("never surfaces internal/technical wording", () => {
  const { html, text } = buildNewLeadReminderEmail(newLead());
  for (const body of [html, text]) {
    assert.ok(!body.includes("AUTOMATIC"));
    assert.ok(!body.includes("מעקב אוטומטי לליד חדש"));
  }
});

test("escapes HTML-special characters in user-provided text", () => {
  const { html } = buildManualFollowUpReminderEmail(manual({ name: "<b>x</b>", notes: `"a" & 'b'` }));
  assert.ok(!html.includes("<b>x</b>"));
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(html.includes("&quot;a&quot; &amp; &#39;b&#39;"));
});
