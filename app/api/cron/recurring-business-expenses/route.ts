// GAL CRM — automatic monthly recurring business-expense scheduler.
//
// Triggered once a day by Vercel Cron (see vercel.json's `crons`
// entry) with GET, exactly like /api/cron/recurring-billing — this
// route is its own separate, independent entry point (own URL, own
// generator function, own database tables) so this feature can never
// interact with — or be confused with — customer recurring billing.
// This is the ENTIRE server-side job: it authenticates the request,
// then calls the single SQL function that does all the actual work —
// see supabase/migrations/20260904090000_..._recurring_business_expenses.sql
// for the generation/catch-up/idempotency logic itself. Nothing here
// decides WHICH recurring expenses are due or HOW MANY months to
// backfill — that is entirely the database's job, by design.
//
// Security: authenticated via the SAME CRON_SECRET as the recurring-
// billing route (see lib/cron/auth.ts) — Vercel automatically sends
// "Authorization: Bearer <CRON_SECRET>" when that environment variable
// is configured on the project. Fails closed (401) if CRON_SECRET
// isn't configured at all.
//
// Uses createAdminClient() (service_role) — the only caller of
// generate_due_recurring_business_expenses() with EXECUTE privilege on
// it (see that function's own REVOKE/GRANT) — never reachable via a
// normal authenticated CRM session or the browser.
import { createAdminClient } from "../../../../lib/supabase/admin.ts";
import { getCronSecret } from "../../../../lib/cron/env.ts";
import { verifyCronAuthHeader } from "../../../../lib/cron/auth.ts";

export const runtime = "nodejs";
// Same generous headroom as recurring-billing's own route, for the
// same reason: cheap insurance against an unusually large catch-up
// backfill after extended downtime.
export const maxDuration = 60;

type GeneratedRow = {
  out_recurring_expense_id: string;
  out_expense_id: string;
  out_occurrence_month: string;
  out_amount_minor: number;
};

export async function GET(request: Request): Promise<Response> {
  let expectedSecret: string;
  try {
    expectedSecret = getCronSecret();
  } catch {
    // Missing server config — fail closed. Never log the (absent) secret.
    return new Response("Scheduled business-expense generation is not configured.", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (!verifyCronAuthHeader(authHeader, expectedSecret)) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("generate_due_recurring_business_expenses");

  if (error) {
    // Never expose the raw Postgres error to a public-shaped response
    // beyond what's already logged server-side.
    console.error(
      JSON.stringify({ step: "recurring_business_expenses_cron_failed", message: error.message })
    );
    return Response.json({ ok: false }, { status: 500 });
  }

  const generated = (data ?? []) as GeneratedRow[];
  // Only ids/counts/dates — never a description or category detail.
  console.log(
    JSON.stringify({
      step: "recurring_business_expenses_cron_completed",
      generatedCount: generated.length,
      occurrences: generated.map((g) => ({
        recurringExpenseId: g.out_recurring_expense_id,
        occurrenceMonth: g.out_occurrence_month,
      })),
    })
  );

  return Response.json({ ok: true, generatedCount: generated.length });
}
