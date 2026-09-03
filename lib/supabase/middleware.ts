import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server.js";
import { getSupabaseEnv } from "./env.ts";

// Paths that never require a CRM session.
const PUBLIC_PATHS = ["/login"];

// API routes bypass this middleware's session handling ENTIRELY (no
// Supabase client, no getUser() call, no redirect) — added in the
// Phase 3C production-readiness audit.
//
// Root cause found: this middleware's redirect-to-/login behavior is
// designed for browser page navigation, not API callers. Before this
// fix, EVERY /api/* route — including app/api/meta/leadgen-webhook,
// which Meta calls directly with no Supabase session cookie at all —
// was being 307-redirected to an HTML /login page instead of ever
// reaching its actual route handler. That would have silently broken
// the entire webhook integration in production (Meta would see a
// redirect, never a 200/401/500 from the real handler), despite every
// other check (signature verification, RLS, grants, ...) being
// correct. Confirmed live: a local `next dev` request to
// /api/meta/leadgen-webhook/health returned 307 -> /login before this
// fix.
//
// Skipping this middleware entirely for /api (rather than just
// skipping the redirect) also avoids an unnecessary Supabase Auth
// getUser() network round-trip on every webhook delivery — API routes
// authenticate themselves in whatever way is appropriate to them (the
// Meta webhook uses X-Hub-Signature-256; a future session-authenticated
// API route should return 401 JSON on its own rather than relying on
// this page-oriented redirect). This does not weaken protection for
// any actual page: every protected page lives under app/(app)/* and
// has no "/api" prefix.
const API_PATH_PREFIX = "/api";

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
  if (request.nextUrl.pathname.startsWith(API_PATH_PREFIX)) {
    return NextResponse.next({ request });
  }

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
