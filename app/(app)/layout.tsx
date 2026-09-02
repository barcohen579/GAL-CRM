import { redirect } from "next/navigation";
import { getCrmUser } from "@/lib/supabase/get-crm-user";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";

// force-dynamic is explicit here rather than relying on Next.js
// to infer it from the dynamic APIs inside getCrmUser(), since that
// inference only fires when the dynamic call is actually reached during
// a build — a fail-closed early return can short-circuit before that
// happens. Every page under this layout renders per-user data and must
// never be statically cached.
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const result = await getCrmUser();

  if (result.status === "unauthenticated") {
    redirect("/login");
  }

  if (result.status === "unauthorized") {
    redirect("/unauthorized");
  }

  const { appUser } = result;

  // Lightweight, layout-wide signal for the sidebar's overdue badge.
  // Deliberately just a count (head:true — no rows fetched) so it stays
  // cheap on every navigation.
  const supabase = await createClient();
  const { count: overdueFollowUps } = await supabase
    .from("follow_up_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "PENDING")
    .lt("due_at", new Date().toISOString());

  return (
    <AppShell fullName={appUser.full_name} overdueFollowUps={overdueFollowUps ?? 0}>
      {children}
    </AppShell>
  );
}
