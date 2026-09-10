// GAL CRM — Zapier Facebook Lead ingestion readiness check.
//
// Mirrors app/api/meta/leadgen-webhook/health's own reasoning exactly:
// confirm required server configuration is present BEFORE pointing the
// Zapier "Webhooks by Zapier" action at this endpoint. Reports ONLY
// booleans — never a value, a prefix, a length, or any database
// content. Safe to leave publicly reachable: GET only, no side effects,
// reveals no secret.

function isConfigured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export async function GET(): Promise<Response> {
  const checks = {
    supabaseUrlConfigured: isConfigured(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnonKeyConfigured: isConfigured(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    supabaseServiceRoleKeyConfigured: isConfigured(process.env.SUPABASE_SERVICE_ROLE_KEY),
    zapierLeadWebhookSecretConfigured: isConfigured(process.env.ZAPIER_LEAD_WEBHOOK_SECRET),
  };

  const ready = Object.values(checks).every(Boolean);

  return Response.json({ ready, checks }, { status: ready ? 200 : 503 });
}
