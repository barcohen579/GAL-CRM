import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./env";

// Supabase client for use in Client Components ("use client").
//
// Uses the public anon key, which is safe to ship to the browser — access
// control is enforced by Postgres Row Level Security (see the CRM
// migrations), not by keeping this key secret. Never use the
// service_role key here.
export function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  return createBrowserClient(url, anonKey);
}
