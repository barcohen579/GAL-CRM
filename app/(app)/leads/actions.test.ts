import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regression coverage for the "Remove legacy follow-up field from Add
// Lead" product cleanup: createLead() used to accept an optional
// follow-up date/time and, when supplied, insert a second, MANUAL
// follow-up task with a generic title alongside the lead. Now that
// every new lead already gets its own Day-0 AUTOMATIC follow-up from
// the create_automatic_followup_for_new_lead() DB trigger (see
// supabase/migrations/20260904161000_..._automatic_lead_followup_escalation.sql
// and supabase/tests/automatic_lead_followup_escalation.test.sql, both
// untouched by this change and still the source of truth for that DB
// behavior), that extra MANUAL row was pure duplication — it only ever
// suppressed the AUTOMATIC one from the actionable UI (see
// lib/crm/follow-up-visibility.ts and its own tests) for no benefit.
//
// createLead() itself is a "use server" action that talks to a live
// Supabase client, so it isn't unit-testable in isolation without a
// database — this file follows the same source-inspection pattern
// already used elsewhere in the repo (e.g.
// app/api/cron/recurring-billing/health/route.test.ts) to lock in the
// removal at the code level.

const actionsSource = fs.readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const dialogSource = fs.readFileSync(
  new URL("../../../components/leads/add-lead-dialog.tsx", import.meta.url),
  "utf8"
);

test("createLead no longer reads a follow-up date/time field from the Add Lead form", () => {
  assert.ok(!/follow_up_at/.test(actionsSource), "must not reference the removed follow_up_at field");
});

test("createLead no longer inserts into follow_up_tasks — the Add Lead flow cannot create the legacy extra MANUAL follow-up", () => {
  assert.ok(
    !/follow_up_tasks/.test(actionsSource),
    "createLead must leave follow-up creation entirely to the DB trigger (AUTOMATIC) and the follow-ups UI (MANUAL, via מעקב חדש)"
  );
});

test("the Add Lead dialog no longer renders the follow-up date/time field", () => {
  assert.ok(!/follow_up_at/.test(dialogSource), "must not render the removed follow_up_at input");
  assert.ok(
    !/תאריך ושעת מעקב/.test(dialogSource),
    "must not render the removed follow-up date/time label"
  );
});

test("the Add Lead dialog still submits to createLead unchanged (general Add Lead functionality is not removed)", () => {
  assert.ok(/createLead/.test(dialogSource));
  assert.ok(/full_name/.test(dialogSource), "the rest of the Add Lead form must be untouched");
});
