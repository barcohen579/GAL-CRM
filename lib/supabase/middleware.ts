import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "./env";

// Paths that never require a CRM session.
const PUBLIC_PATHS = ["/login"];

// Runs on (almost) every request. Two jobs:
//   1. Keep the Supabase session cookie fresh (refresh the access token
//      before it expires), using getUser() — not getSession() — because
//      getUser() revalidates the token against Supabase Auth instead of
//      just trusting whatever is in the cookie.
//   2. Optimistically redirect unauthenticated requests for protected
//      paths to /login, purely for a fast/clean UX. This is NOT the only
//      authorization check — it only confirms a Supabase session exists,
//      not that the user is an active public.app_users CRM member. The
//      real, database-enforced check happens in getCrmUser() on the
//      protected page itself (see lib/supabase/get-crm-user.ts).
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const isPublicPath = PUBLIC_PATHS.some((path) =>
    request.nextUrl.pathname.startsWith(path)
  );

  let url: string;
  let anonKey: string;
  try {
    ({ url, anonKey } = getSupabaseEnv());
  } catch {
    // Supabase isn't configured yet (e.g. .env.local not created). Fail
    // closed: never let a protected path through without being able to
    // verify a session — but don't block the public /login path either.
    if (isPublicPath) return supabaseResponse;
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  let user = null;
  try {
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();
    user = currentUser;
  } catch {
    // Any failure verifying the session fails closed (treated as no
    // session) rather than silently letting the request through.
    user = null;
  }

  if (!user && !isPublicPath) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return supabaseResponse;
}
