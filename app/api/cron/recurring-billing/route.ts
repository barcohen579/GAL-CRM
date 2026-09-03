// GAL CRM — automatic monthly recurring billing scheduler.
//
// Triggered once a day by Vercel Cron (see vercel.json's `crons`
// entry) with GET, exactly as Vercel Cron always calls a route. This
// is the ENTIRE server-side job: it authenticates the request, then
// calls the single SQL function that does all the actual work — see
// supabase/migrations/20260903150200_..._recurring_billing_generator.sql
// for the generation/catch-up/idempotency logic itself. Nothing here
// decides WHICH purchases are due or HOW MANY cycles to backfill —
// that is entirely the database's job, by design (a scheduled job
// misfiring or retrying is a normal, expected event; the DB-level
// unique constraint is the actual safety net, not this route's care).
//
// Security: authenticated via CRON_SECRET (see lib/cron/auth.ts) —
// Vercel automatically sends "Authorization: Bearer <CRON_SECRET>"
// when that environment variable is configured on the project. A
// `crons` entry in vercel.json only controls SCHEDULING; without this
// check, the exact same URL would be callable by literally anyone on
// the internet to generate financial records. Fails closed (401) if
// CRON_SECRET isn't configured at all — same fail-closed convention as
// every other secret accessor in this codebase (lib/meta/env.ts).
//
// Uses createAdminClient() (service_role) — the only caller of
// generate_due_recurring_payments() with EXECUTE privilege on it (see
// that function's own REVOKE/GRANT) — never reachable via a normal
// authenticated CRM session or the browser.
import { createAdminClient } from "../../../../lib/supabase/admin.ts";
import { getCronSecret } from "../../../../lib/cron/env.ts";
import { verifyCronAuthHeader } from "../../../../lib/cron/auth.ts";

export const runtime = "nodejs";
// Generous headroom over the expected sub-second runtime (this
// business's realistic scale is a handful to a few dozen active
// recurring purchases) — cheap insurance against an unusually large
// catch-up backfill after extended downtime, well within Vercel's
// serverless function limits.
export const maxDuration = 60;

type GeneratedRow = {
  out_purchase_id: string;
  out_payment_id: string;
  out_customer_id: string;
  out_billing_cycle: string;
  out_amount: number;
};

export async function GET(request: Request): Promise<Response> {
  let expectedSecret: string;
  try {
    expectedSecret = getCronSecret();
  } catch {
    // Missing server config — fail closed. Never log the (absent) secret.
    return new Response("Scheduled billing is not configured.", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (!verifyCronAuthHeader(authHeader, expectedSecret)) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("generate_due_recurring_payments");

  if (error) {
    // Never expose the raw Postgres error to a public-shaped response
    // beyond what's already logged server-side — this endpoint returns
    // no request-identifying or financial detail either way.
    console.error(JSON.stringify({ step: "recurring_billing_cron_failed", message: error.message }));
    return Response.json({ ok: false }, { status: 500 });
  }

  const generated = (data ?? []) as GeneratedRow[];
  // Only ids/counts/dates — never a customer name, phone, or email.
  console.log(
    JSON.stringify({
      step: "recurring_billing_cron_completed",
      generatedCount: generated.length,
      cycles: generated.map((g) => ({
        purchaseId: g.out_purchase_id,
        billingCycle: g.out_billing_cycle,
      })),
    })
  );

  return Response.json({ ok: true, generatedCount: generated.length });
}
