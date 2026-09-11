// GAL CRM — Meta sync freshness status (read-only).
//
// Polled by components/dashboard/meta-freshness-indicator.tsx while a
// sync is in flight, so the Dashboard can flip from "מעדכן נתוני
// Meta..." to the new totals (via router.refresh()) without an F5.
// Session-authenticated only (getCrmUser()) — this is always called from
// the browser, which always carries the session cookie; no service-role
// client, no admin import, reads meta_sync_state through the normal
// RLS-scoped client (authenticated has SELECT — see the table's own
// migration).
import { createClient } from "../../../../lib/supabase/server.ts";
import { getCrmUser } from "../../../../lib/supabase/get-crm-user.ts";
import { computeSyncFreshness } from "../../../../lib/meta/sync-freshness.ts";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const auth = await getCrmUser();
  if (auth.status !== "authorized") {
    return new Response("Unauthorized.", { status: 401 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("meta_sync_state")
    .select("status, last_success_at")
    .eq("source", "META")
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ step: "meta_sync_status_lookup_failed", error: error.message }));
    return Response.json({ ok: false }, { status: 500 });
  }

  const freshness = computeSyncFreshness(
    data ? { status: data.status, lastSuccessAt: data.last_success_at } : null
  );

  return Response.json({ ok: true, ...freshness });
}
