import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regression coverage for the "Remove legacy follow-up field from Add
// Lead" product cleanup (see app/(app)/leads/actions.test.ts for the
// removal itself): that change only touched createLead() in
// app/(app)/leads/actions.ts. "מעקב חדש" — creating a MANUAL follow-up
// by hand from a lead's own detail page, via createFollowUp here — is
// explicitly required to keep working exactly as before. createFollowUp
// is a "use server" action backed by a live Supabase client, so (as in
// app/(app)/leads/actions.test.ts) this is a source-inspection check
// rather than an executed call.
//
// Also covers "One current MANUAL follow-up per Lead" (see
// supabase/migrations/20260904170000_..._one_current_manual_follow_up_rpc.sql):
// for a Lead-linked follow-up, createFollowUp must go through the
// authoritative create_manual_follow_up_for_lead RPC — which atomically
// supersedes any existing PENDING MANUAL follow-up on that lead — rather
// than a plain insert that would leave two PENDING MANUAL rows behind
// (exactly the ליד בדיקה Production shape this whole feature exists to
// prevent going forward). A customer-linked follow-up has no AUTOMATIC
// fallback to coordinate with, so it deliberately keeps the plain
// insert — these assertions confirm that split, not just "the RPC name
// appears somewhere in the file".

const source = fs.readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

test("createFollowUp (\"מעקב חדש\") still exists and still requires an explicit date and time", () => {
  assert.ok(/export async function createFollowUp/.test(source));
  assert.ok(/formData\.get\("date"\)/.test(source));
  assert.ok(/formData\.get\("time"\)/.test(source));
});

test("a Lead-linked MANUAL follow-up is created via the create_manual_follow_up_for_lead RPC, not a plain insert", () => {
  assert.ok(
    /\.rpc\(\s*"create_manual_follow_up_for_lead"/.test(source),
    "createFollowUp must call the authoritative supersede-and-create RPC for a lead_id target"
  );
});

test("a customer-linked MANUAL follow-up still uses a plain insert — the one-current-manual invariant is Lead-specific, customers have no AUTOMATIC fallback", () => {
  assert.ok(
    /\.from\("follow_up_tasks"\)\s*\.insert\(\{[\s\S]*?customer_id:\s*customerId/.test(source),
    "createFollowUp must still directly insert for a customer_id target"
  );
});
