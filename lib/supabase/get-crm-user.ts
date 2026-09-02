import { createClient } from "./server";

export type CrmAuthResult =
  | { status: "unauthenticated" }
  | { status: "unauthorized" }
  | {
      status: "authorized";
      appUser: { id: string; full_name: string; is_active: boolean };
    };

// Verifies both layers required for CRM access:
//   1. A valid Supabase Auth session (authentication).
//   2. An active row in public.app_users linked to that session
//      (authorization — being a logged-in Supabase user is NOT enough).
//
// The public.app_users lookup below is not just an application-level
// check: it relies on the app_users_crm_select RLS policy, which itself
// calls public.is_crm_user() and only returns a row when the caller has
// an ACTIVE app_users row. So if `appUser` comes back null here, that is
// a real, database-enforced fact, not merely something this function
// forgot to check — the `!appUser.is_active` condition below is
// deliberate defense-in-depth on top of that guarantee, not the primary
// mechanism.
//
// Call this from any protected Server Component. Any failure anywhere in
// the pipeline (including missing Supabase configuration) is treated as
// "unauthenticated" — fail closed, never open.
export async function getCrmUser(): Promise<CrmAuthResult> {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { status: "unauthenticated" };
    }

    const { data: appUser } = await supabase
      .from("app_users")
      .select("id, full_name, is_active")
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (!appUser || !appUser.is_active) {
      // Authenticated with Supabase, but not an authorized/active CRM
      // user. Sign them out rather than leaving a half-logged-in session
      // sitting around with a Supabase Auth cookie but no CRM access.
      await supabase.auth.signOut();
      return { status: "unauthorized" };
    }

    return { status: "authorized", appUser };
  } catch {
    return { status: "unauthenticated" };
  }
}
