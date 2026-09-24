import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { automaticFollowUpDueAtIso, followUpReminderAtIso } from "./timezone.ts";
import {
  filterActionableFollowUps,
  followUpDisplayTitle,
  overdueActionableFollowUps,
} from "./follow-up-visibility.ts";
import { buildLeadTimeline, stageEventLostReason } from "./timeline.ts";
import {
  LEAD_CONVERSATION_OUTCOMES,
  LEAD_CONVERSATION_OUTCOME_LABELS,
  LEAD_LOST_REASONS,
  LEAD_LOST_REASON_LABELS,
} from "./constants.ts";
import type { LeadDetail, StageEvent } from "./types.ts";
import { createFakeDb, createFakeMetaIngestionRepo } from "../meta/fakes.ts";
import { processZapierLead } from "../meta/zapier-ingest.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ------------------------------------------------------------------
// Reminder timing (TS mirror of SQL follow_up_reminder_at)
// ------------------------------------------------------------------

test("new lead: its one reminder is 10:00 Israel on the next business day (no reminder at creation)", () => {
  // Monday 2026-09-21 14:00 IDT -> Tuesday 10:00 IDT (07:00Z)
  const due = automaticFollowUpDueAtIso("2026-09-21T11:00:00.000Z");
  assert.equal(due, "2026-09-22T07:00:00.000Z");
  assert.equal(followUpReminderAtIso("AUTOMATIC", due), due);
});

test("new lead on Thursday evening / Friday / Saturday: reminder Sunday 10:00", () => {
  assert.equal(automaticFollowUpDueAtIso("2026-09-24T17:00:00.000Z"), "2026-09-27T07:00:00.000Z"); // Thu 20:00
  assert.equal(automaticFollowUpDueAtIso("2026-09-25T09:00:00.000Z"), "2026-09-27T07:00:00.000Z"); // Fri
  assert.equal(automaticFollowUpDueAtIso("2026-09-26T09:00:00.000Z"), "2026-09-27T07:00:00.000Z"); // Sat
});

test("manual follow-up due Tuesday (any hour) -> one reminder Wednesday 10:00", () => {
  assert.equal(followUpReminderAtIso("MANUAL", "2026-09-22T05:00:00.000Z"), "2026-09-23T07:00:00.000Z"); // Tue 08:00
  assert.equal(followUpReminderAtIso("MANUAL", "2026-09-22T20:30:00.000Z"), "2026-09-23T07:00:00.000Z"); // Tue 23:30
});

test("manual follow-up due Thursday, Friday or Saturday -> reminder Sunday 10:00 (never Fri/Sat)", () => {
  for (const due of ["2026-09-24T09:00:00.000Z", "2026-09-25T09:00:00.000Z", "2026-09-26T09:00:00.000Z"]) {
    assert.equal(followUpReminderAtIso("MANUAL", due), "2026-09-27T07:00:00.000Z");
  }
});

test("manual follow-up due just after Israel midnight belongs to the new Israel day", () => {
  // Wed 2026-09-23 00:15 IDT = Tue 21:15Z -> due date is WEDNESDAY -> Thu 10:00
  assert.equal(followUpReminderAtIso("MANUAL", "2026-09-22T21:15:00.000Z"), "2026-09-24T07:00:00.000Z");
});

test("DST end (25 Oct 2026): a Thursday follow-up reminds Sunday 10:00 IST = 08:00Z", () => {
  assert.equal(followUpReminderAtIso("MANUAL", "2026-10-22T09:00:00.000Z"), "2026-10-25T08:00:00.000Z");
});

test("DST start (27 Mar 2026): a Thursday follow-up reminds Sunday 10:00 IDT = 07:00Z", () => {
  assert.equal(followUpReminderAtIso("MANUAL", "2026-03-26T09:00:00.000Z"), "2026-03-29T07:00:00.000Z");
});

test("cron schedule: a 07:00Z and an 08:00Z entry, so one tick lands at 10:00 Israel in both DST regimes", () => {
  const crons = JSON.parse(read("vercel.json")).crons as { path: string; schedule: string }[];
  const schedules = crons.filter((c) => c.path === "/api/cron/follow-up-notifications").map((c) => c.schedule);
  assert.ok(schedules.includes("0 7 * * *"));
  assert.ok(schedules.includes("0 8 * * *"));
  for (const s of schedules) assert.ok(Number(s.split(" ")[1]) >= 7, "no tick before 10:00 Israel time");
});

// ------------------------------------------------------------------
// Nav badge and /follow-ups agree
// ------------------------------------------------------------------

type T = { id: string; source: string; lead: string | null; due: string };
const info = (t: T) => ({ source: t.source, status: "PENDING", leadId: t.lead, dueAt: t.due });

test("badge and /follow-ups use the same overdue rule on the FULL pending set", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const pending: T[] = [
    { id: "auto", source: "AUTOMATIC", lead: "L1", due: "2026-09-22T07:00:00.000Z" }, // overdue but suppressed
    { id: "manual", source: "MANUAL", lead: "L1", due: "2026-09-25T07:00:00.000Z" }, // future manual
    { id: "late", source: "MANUAL", lead: "L2", due: "2026-09-22T07:00:00.000Z" }, // genuinely overdue
  ];
  const badge = overdueActionableFollowUps(pending, info, now).map((t) => t.id);
  const pageOverdue = filterActionableFollowUps(pending, info)
    .filter((t) => new Date(t.due) < now)
    .map((t) => t.id);
  assert.deepEqual(badge, ["late"]);
  assert.deepEqual(badge, pageOverdue);
});

test("the old badge bug is gone: an overdue AUTOMATIC with a future MANUAL is not counted", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const pending: T[] = [
    { id: "auto", source: "AUTOMATIC", lead: "L1", due: "2026-09-22T07:00:00.000Z" },
    { id: "manual", source: "MANUAL", lead: "L1", due: "2026-09-30T07:00:00.000Z" },
  ];
  assert.equal(overdueActionableFollowUps(pending, info, now).length, 0);
});

test("technical AUTOMATIC titles are never shown in summary views", () => {
  assert.equal(followUpDisplayTitle({ source: "AUTOMATIC", title: "מעקב אוטומטי לליד חדש" }), "ליד חדש — ליצור קשר ראשון");
  assert.equal(followUpDisplayTitle({ source: "MANUAL", title: "לחזור אליה" }), "לחזור אליה");
});

// ------------------------------------------------------------------
// LOST reasons
// ------------------------------------------------------------------

test("LOST reason options are exactly the approved Hebrew list, in order", () => {
  assert.deepEqual(
    LEAD_LOST_REASONS.map((r) => LEAD_LOST_REASON_LABELS[r]),
    [
      "רחוקה מדי מהסטודיו",
      "המחיר גבוה מדי",
      "השעות לא מתאימות",
      "אין סידור לילדים",
      "לא מעוניינת כרגע",
      "בחרה סטודיו או מאמנת אחרת",
      "לא ענתה לאחר ניסיונות קשר",
      "רוצה להתחיל במועד מאוחר יותר",
      "מחפשת שירות שאנחנו לא מציעים",
      "לא מתאימה למסגרת האימונים",
      "פרטים שגויים / ליד לא רלוונטי",
      "סיבה אחרת",
    ]
  );
});

test("historical legacy reasons remain readable", () => {
  assert.equal(LEAD_LOST_REASON_LABELS.TIMING, "לא הזמן המתאים");
});

const ev = (o: Partial<StageEvent>): StageEvent => ({
  id: "e1",
  from_stage: "CONTACTED",
  to_stage: "LOST",
  changed_at: "2026-09-20T10:00:00.000Z",
  note: null,
  ...o,
});

test("LOST reason is read from the stage event itself: structured column, then legacy note, never invented", () => {
  assert.equal(stageEventLostReason(ev({ lost_reason: "TOO_FAR" })), "TOO_FAR");
  assert.equal(stageEventLostReason(ev({ note: "PRICE" })), "PRICE");
  assert.equal(stageEventLostReason(ev({})), null);
  assert.equal(stageEventLostReason(ev({ to_stage: "CONTACTED", lost_reason: "PRICE" })), null);
});

function leadWith(partial: Partial<LeadDetail>): LeadDetail {
  return {
    id: "L1",
    stage: "CONTACTED",
    stage_changed_at: "2026-09-21T10:00:00.000Z",
    interested_services: [],
    lost_reason: null,
    created_at: "2026-09-19T10:00:00.000Z",
    updated_at: "2026-09-21T10:00:00.000Z",
    contact: { id: "C1", full_name: "דנה", phone: null, email: null, instagram_username: null, notes: null } as LeadDetail["contact"],
    touchpoints: [],
    follow_up_tasks: [],
    stage_events: [],
    conversation_updates: [],
    ...partial,
  };
}

test("LOST reason and explanation stay visible in history after the lead is reopened", () => {
  const timeline = buildLeadTimeline(
    leadWith({
      stage: "CONTACTED", // reopened — leads.lost_reason is now null
      stage_events: [
        ev({ id: "lost", lost_reason: "OTHER", lost_reason_note: "עוברת דירה", changed_at: "2026-09-20T10:00:00.000Z" }),
        ev({ id: "reopen", from_stage: "LOST", to_stage: "CONTACTED", changed_at: "2026-09-21T10:00:00.000Z" }),
      ],
    })
  );
  const lost = timeline.find((e) => e.id === "stage-lost");
  assert.equal(lost?.description, "סיבה: סיבה אחרת — עוברת דירה");
});

// ------------------------------------------------------------------
// Conversation history
// ------------------------------------------------------------------

test("conversation outcomes are the approved set, all in Hebrew", () => {
  assert.equal(LEAD_CONVERSATION_OUTCOMES.length, 9);
  assert.equal(LEAD_CONVERSATION_OUTCOME_LABELS.CALL_TOMORROW, "להתקשר מחר");
  assert.equal(LEAD_CONVERSATION_OUTCOME_LABELS.CALL_BACK_LATER, "לחזור אליה בתאריך אחר");
  assert.equal(LEAD_CONVERSATION_OUTCOME_LABELS.WANTS_TRIAL, "רוצה לקבוע אימון ניסיון");
  assert.equal(LEAD_CONVERSATION_OUTCOME_LABELS.NO_ANSWER, "לא ענתה");
  for (const o of LEAD_CONVERSATION_OUTCOMES) assert.ok(/[֐-׿]/.test(LEAD_CONVERSATION_OUTCOME_LABELS[o]));
});

test("multiple conversation notes are all preserved in the timeline, with outcome, note and linked follow-up", () => {
  const timeline = buildLeadTimeline(
    leadWith({
      follow_up_tasks: [
        {
          id: "F1", title: "להתקשר אליה", notes: null, due_at: "2026-09-22T07:00:00.000Z", status: "PENDING",
          completed_at: null, completed_note: null, auto_closed_reason: null, source: "MANUAL",
          created_at: "2026-09-21T10:00:00.000Z", updated_at: "2026-09-21T10:00:00.000Z",
        },
      ],
      conversation_updates: [
        { id: "c1", outcome: "NO_ANSWER", note: null, stage_before: "NEW", stage_after: "NEW", follow_up_task_id: null, created_at: "2026-09-20T09:00:00.000Z" },
        { id: "c2", outcome: "CALL_TOMORROW", note: "ביקשה שנדבר מחר בבוקר", stage_before: "NEW", stage_after: "CONTACTED", follow_up_task_id: "F1", created_at: "2026-09-21T10:00:00.000Z" },
      ],
    })
  );
  const c1 = timeline.find((e) => e.id === "conversation-c1");
  const c2 = timeline.find((e) => e.id === "conversation-c2");
  assert.equal(c1?.title, "עדכון שיחה: לא ענתה");
  assert.equal(c2?.title, "עדכון שיחה: להתקשר מחר");
  assert.equal(c2?.description, "ביקשה שנדבר מחר בבוקר · נוצר מעקב: להתקשר אליה");
  assert.ok(timeline.some((e) => e.id === "task-created-F1"));
});

// ------------------------------------------------------------------
// Meta ingestion: repeated submission on an existing open lead
// ------------------------------------------------------------------

test("a repeated Meta submission for an existing open lead is recorded as NOT a new lead", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);
  const base = { fullName: "דנה", phone: "0501234567", email: null, occurredAt: null, pageId: null, formId: null, formName: null, adId: null, adName: null, adsetId: null, adsetName: null, campaignId: null, campaignName: null, source: null };
  const first = await processZapierLead(repo, { ...base, facebookLeadId: "A" }, new Date().toISOString());
  const second = await processZapierLead(repo, { ...base, facebookLeadId: "B" }, new Date().toISOString());
  assert.equal(first.outcome, "processed");
  assert.equal(second.outcome, "processed");
  if (first.outcome !== "processed" || second.outcome !== "processed") return;
  assert.equal(second.leadId, first.leadId, "same lead — touchpoint added, no new lead");
  const rows = [...db.ingestions.values()] as { leadgen_id: string; created_new_lead?: boolean | null }[];
  assert.equal(rows.find((r) => r.leadgen_id === "A")?.created_new_lead, true);
  assert.equal(rows.find((r) => r.leadgen_id === "B")?.created_new_lead, false);
});

// ------------------------------------------------------------------
// Retired notification paths stay retired
// ------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx)$/.test(d.name) && !/\.test\.ts$/.test(d.name) ? [rel] : [];
  });
}

test("the reminder job is the ONLY place in the app that sends email", () => {
  const senders = [...sourceFiles("app"), ...sourceFiles("lib")].filter((f) => /\.send\(\{/.test(read(f)));
  assert.deepEqual(senders.map((f) => f.replace(/\\/g, "/")), ["lib/notifications/reminder-job.ts"]);
});

test("no immediate new-lead email, digest or escalation code path remains", () => {
  // Code only — comments documenting what was retired are fine.
  const all = [...sourceFiles("app"), ...sourceFiles("lib")]
    .map(read)
    .join("\n")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  for (const retired of [
    "sendNewLeadNotification",
    "processNewLeadNotificationRetries",
    "processDailyDigest",
    "processAutomaticEscalations",
    "buildDailyDigestEmail",
    "lead_auto_escalation_deliveries",
    "daily_digest_deliveries",
    "notification_attempt_count",
  ]) {
    assert.ok(!all.includes(retired), `${retired} must not be referenced by application code`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "lib/notifications/new-lead-notification.ts")));
});

test("both Meta ingestion routes no longer import any email code", () => {
  for (const f of ["app/api/zapier/facebook-leads/route.ts", "app/api/meta/leadgen-webhook/route.ts"]) {
    const s = read(f);
    assert.ok(!/notifications\//.test(s), `${f} must not import notification modules`);
  }
});

test("lead actions use the atomic RPCs (manual creation, LOST reason, conversation update)", () => {
  const s = read("app/(app)/leads/actions.ts");
  assert.ok(/\.rpc\("create_lead_manually"/.test(s));
  assert.ok(!/\.from\("contacts"\)\s*\.insert/.test(s), "no separate contact insert");
  assert.ok(/p_lost_reason_note/.test(s));
  assert.ok(/\.rpc\("record_lead_conversation"/.test(s));
  assert.ok(/lostReason === "OTHER" && !note/.test(s), "'סיבה אחרת' requires an explanation");
});

test("open leads with no pending follow-up are surfaced for scheduling; resolved or scheduled leads are not", async () => {
  const { openLeadsWithoutFollowUp } = await import("./follow-up-visibility.ts");
  const leads = [
    { id: "in-progress", stage: "CONTACTED" },
    { id: "scheduled", stage: "INTERESTED" },
    { id: "new-with-auto", stage: "NEW" },
    { id: "won", stage: "WON" },
    { id: "lost", stage: "LOST" },
  ];
  const result = openLeadsWithoutFollowUp(leads, ["scheduled", "new-with-auto", null]);
  assert.deepEqual(result.map((l) => l.id), ["in-progress"]);
});
