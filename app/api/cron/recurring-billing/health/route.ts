// GAL CRM — recurring-billing scheduler readiness check.
//
// Purpose: after deploying, confirm CRON_SECRET is actually configured
// in Production — the one thing this feature's launch can't verify
// any other way, since actually invoking the scheduled job as a "test"
// against real customer data is explicitly out of scope (see
// app/api/cron/recurring-billing/route.ts's own header comment). This
// mirrors app/api/meta/leadgen-webhook/health/route.ts's own established
// pattern and reasoning, kept as a SEPARATE endpoint rather than folded
// into that one — that endpoint's `ready` boolean is specifically
// Meta-integration-scoped; conflating an unrelated secret's presence
// into it would make its readiness signal ambiguous.
//
// Deliberately reports ONLY a boolean (present/absent) — never the
// value, a prefix, or a length. Safe to leave publicly reachable:
// possessing this URL reveals no secret and cannot trigger any action
// (GET only, no side effects, does not call Supabase or generate
// anything).

function isConfigured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export async function GET(): Promise<Response> {
  const checks = {
    cronSecretConfigured: isConfigured(process.env.CRON_SECRET),
  };

  const ready = Object.values(checks).every(Boolean);

  return Response.json({ ready, checks }, { status: ready ? 200 : 503 });
}
