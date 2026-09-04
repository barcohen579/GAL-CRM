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

const source = fs.readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

test("createFollowUp (\"מעקב חדש\") still exists and still creates a MANUAL follow-up task", () => {
  assert.ok(/export async function createFollowUp/.test(source));
  assert.ok(
    /\.from\("follow_up_tasks"\)\s*\.insert\(\{[\s\S]*?source:\s*"MANUAL"/.test(source),
    "createFollowUp must still insert a follow_up_tasks row with source: \"MANUAL\""
  );
});

test("createFollowUp still requires an explicit date and time (unaffected by the Add Lead cleanup)", () => {
  assert.ok(/formData\.get\("date"\)/.test(source));
  assert.ok(/formData\.get\("time"\)/.test(source));
});
