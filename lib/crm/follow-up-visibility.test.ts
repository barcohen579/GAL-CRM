import { test } from "node:test";
import assert from "node:assert/strict";
import { filterActionableFollowUps, type FollowUpVisibilityInfo } from "./follow-up-visibility.ts";

type Task = { id: string; source: string; status: string; leadId: string | null };

function getInfo(t: Task): FollowUpVisibilityInfo {
  return { source: t.source, status: t.status, leadId: t.leadId };
}

test("an AUTOMATIC follow-up is visible when no manual task exists for the same lead", () => {
  const tasks: Task[] = [{ id: "auto-1", source: "AUTOMATIC", status: "PENDING", leadId: "lead-1" }];
  const result = filterActionableFollowUps(tasks, getInfo);
  assert.deepEqual(result.map((t) => t.id), ["auto-1"]);
});

test("an AUTOMATIC follow-up is hidden when the same lead has an active (PENDING) MANUAL follow-up", () => {
  const tasks: Task[] = [
    { id: "auto-1", source: "AUTOMATIC", status: "PENDING", leadId: "lead-1" },
    { id: "manual-1", source: "MANUAL", status: "PENDING", leadId: "lead-1" },
  ];
  const result = filterActionableFollowUps(tasks, getInfo);
  assert.deepEqual(result.map((t) => t.id), ["manual-1"]);
});

test("the MANUAL follow-up itself always remains visible, whether or not it is currently suppressing an automatic one", () => {
  const tasks: Task[] = [
    { id: "auto-1", source: "AUTOMATIC", status: "PENDING", leadId: "lead-1" },
    { id: "manual-1", source: "MANUAL", status: "PENDING", leadId: "lead-1" },
  ];
  const result = filterActionableFollowUps(tasks, getInfo);
  assert.ok(result.some((t) => t.id === "manual-1"));
});

test("the automatic follow-up becomes visible again once the manual one is COMPLETED (lead still unresolved)", () => {
  const tasks: Task[] = [
    { id: "auto-1", source: "AUTOMATIC", status: "PENDING", leadId: "lead-1" },
    { id: "manual-1", source: "MANUAL", status: "COMPLETED", leadId: "lead-1" },
  ];
  const result = filterActionableFollowUps(tasks, getInfo);
  assert.deepEqual(
    result.map((t) => t.id).sort(),
    ["auto-1", "manual-1"]
  );
});

test("the automatic follow-up becomes visible again once the manual one is CANCELLED (lead still unresolved)", () => {
  const tasks: Task[] = [
    { id: "auto-1", source: "AUTOMATIC", status: "PENDING", leadId: "lead-1" },
    { id: "manual-1", source: "MANUAL", status: "CANCELLED", leadId: "lead-1" },
  ];
  const result = filterActionableFollowUps(tasks, getInfo);
  assert.deepEqual(
    result.map((t) => t.id).sort(),
    ["auto-1", "manual-1"]
  );
});

test("suppression is per-lead — a manual follow-up on a DIFFERENT lead never suppresses this lead's automatic one", () => {
  const tasks: Task[] = [
    { id: "auto-1", source: "AUTOMATIC", status: "PENDING", leadId: "lead-1" },
    { id: "manual-other", source: "MANUAL", status: "PENDING", leadId: "lead-2" },
  ];
  const result = filterActionableFollowUps(tasks, getInfo);
  assert.deepEqual(
    result.map((t) => t.id).sort(),
    ["auto-1", "manual-other"]
  );
});

test("WON/LOST remains excluded: a CANCELLED automatic follow-up (the WON/LOST auto-close) is never treated as actionable by this rule either — real callers already query PENDING-only, so it never even reaches here, but this confirms the function does not independently resurrect it", () => {
  const tasks: Task[] = [{ id: "auto-1", source: "AUTOMATIC", status: "CANCELLED", leadId: "lead-1" }];
  const result = filterActionableFollowUps(tasks, getInfo);
  // Passed through untouched (this function only ever REMOVES PENDING
  // automatic rows, never adds visibility to a non-PENDING one) — the
  // actual exclusion from any actionable list is each caller's own
  // pre-existing `.eq("status", "PENDING")` query/filter, unchanged by
  // this feature; see supabase/tests/automatic_lead_followup_escalation.test.sql
  // for the DB-level proof that WON/LOST flips this row to CANCELLED.
  assert.deepEqual(result.map((t) => t.id), ["auto-1"]);
});

test("a customer-linked follow-up (leadId null) is never suppressed — AUTOMATIC follow-ups are always lead-linked", () => {
  const tasks: Task[] = [{ id: "cust-1", source: "AUTOMATIC", status: "PENDING", leadId: null }];
  const result = filterActionableFollowUps(tasks, getInfo);
  assert.deepEqual(result.map((t) => t.id), ["cust-1"]);
});

// Regression test for a real-Production shape investigated 2026-09-04:
// a lead ended up with its Day-0 AUTOMATIC follow-up PLUS *two* separate
// PENDING MANUAL follow-ups — one auto-created by createLead()'s own
// pre-existing, unrelated "optional follow-up date" field on the New
// Lead form (app/(app)/leads/actions.ts), fired seconds after the lead
// row (and its AUTOMATIC trigger) were created, and one created
// afterwards by hand via the follow-ups UI. A tester mistook the first
// MANUAL row's generic, auto-populated title for the AUTOMATIC one
// (there is no source badge in the UI to tell them apart) and concluded
// suppression had failed — it had not: the true AUTOMATIC row was
// already correctly hidden, and this only proves it stays hidden with
// more than one competing MANUAL row present too.
test("real-world shape: one AUTOMATIC row plus TWO separate PENDING MANUAL rows for the same lead — automatic stays hidden, both manuals stay visible", () => {
  const tasks: Task[] = [
    { id: "automatic-day0", source: "AUTOMATIC", status: "PENDING", leadId: "lead-1" },
    { id: "manual-from-lead-form", source: "MANUAL", status: "PENDING", leadId: "lead-1" },
    { id: "manual-from-follow-ups-ui", source: "MANUAL", status: "PENDING", leadId: "lead-1" },
  ];
  const result = filterActionableFollowUps(tasks, getInfo);
  assert.deepEqual(
    result.map((t) => t.id).sort(),
    ["manual-from-follow-ups-ui", "manual-from-lead-form"]
  );
});
