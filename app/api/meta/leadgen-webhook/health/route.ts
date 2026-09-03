// GAL CRM — Meta lead ingestion readiness check (Phase 3C).
//
// Purpose: after deploying, confirm required server configuration is
// present BEFORE connecting the live webhook in the Meta Developer
// Dashboard — this is the "does production have what it needs" check
// asked for in the Phase 3C production-readiness audit.
//
// Deliberately reports ONLY booleans (each variable present/absent) —
// never a value, a prefix, a length, or any database/Meta content.
// Safe to leave publicly reachable: possessing this URL reveals no
// secret, no token, no lead data, and cannot be used to trigger any
// action (GET only, no side effects).
//
// This intentionally does NOT verify that a token/secret is actually
// VALID (e.g. it does not call the Meta API or Supabase) — only that
// each is configured. Real validity was already confirmed read-only
// during Phase 3A/3B readiness checks; re-verifying live on every hit
// of a public health endpoint would itself be an unnecessary external
// call trigger surface.

function isConfigured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export async function GET(): Promise<Response> {
  const checks = {
    supabaseUrlConfigured: isConfigured(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnonKeyConfigured: isConfigured(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    supabaseServiceRoleKeyConfigured: isConfigured(process.env.SUPABASE_SERVICE_ROLE_KEY),
    metaAccessTokenConfigured: isConfigured(process.env.META_ACCESS_TOKEN),
    metaAppSecretConfigured: isConfigured(process.env.META_APP_SECRET),
    metaWebhookVerifyTokenConfigured: isConfigured(process.env.META_WEBHOOK_VERIFY_TOKEN),
  };

  const ready = Object.values(checks).every(Boolean);

  return Response.json({ ready, checks }, { status: ready ? 200 : 503 });
}
