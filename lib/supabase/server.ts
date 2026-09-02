import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "./env";

// Supabase client for use in Server Components, Server Actions, and Route
// Handlers. Uses the public anon key together with the current request's
// session cookie, so every query still runs as that authenticated user
// and is still subject to Row Level Security — this is not a privileged
// client. Never use the service_role key here.
export async function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // setAll was called from a Server Component render (not a
          // Server Action or Route Handler), where cookies can't be
          // written. Safe to ignore as long as middleware.ts is also
          // refreshing the session on every request.
        }
      },
    },
  });
}
