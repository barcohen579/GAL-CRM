import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env.ts";

// Privileged Supabase client using the service_role key — bypasses Row
// Level Security entirely. SERVER-ONLY, TRUSTED CODE PATHS ONLY (the
// Meta leadgen webhook route and its reprocessing script — see
// scripts/meta-sync.mjs for the established precedent of this exact
// pattern). Never import this from a Server Component, a Server Action
// reachable by normal user input, or anything that runs in — or is
// reachable from — the browser.
//
// Fails closed (throws, does not silently fall back to the anon key)
// when SUPABASE_SERVICE_ROLE_KEY is not configured, so a missing secret
// is a loud startup-time-of-use error, never a quietly-under-privileged
// client.
export function createAdminClient() {
  const { url } = getSupabaseEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY server environment variable. This is " +
        "required for service-role-only operations (Meta lead ingestion) and " +
        "must never be a NEXT_PUBLIC_* variable."
    );
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
