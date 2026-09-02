// Shared, fail-closed accessor for the Supabase connection settings.
// Every Supabase client factory in this app goes through this function
// rather than reading process.env directly, so a missing/misconfigured
// environment produces one clear error instead of a confusing failure
// deep inside the Supabase SDK.
export function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase environment variables. Copy .env.example to " +
        ".env.local and fill in NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY from the Supabase dashboard " +
        "(Project Settings -> API)."
    );
  }

  return { url, anonKey };
}
