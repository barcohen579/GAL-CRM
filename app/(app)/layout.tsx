import { redirect } from "next/navigation";
import { getCrmUser } from "@/lib/supabase/get-crm-user";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { overdueActionableFollowUps } from "@/lib/crm/follow-up-visibility";

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

  // Sidebar overdue badge. Fetches the FULL pending set (not only the
  // overdue rows) and applies the exact same overdueActionableFollowUps
  // rule as the /follow-ups page "באיחור" section, so the two can never
  // disagree (Lead Workflow V2 fix for the audit's badge/page mismatch).
  const supabase = await createClient();
  const { data: pendingRows } = await supabase
    .from("follow_up_tasks")
    .select("id, source, due_at, lead:leads(id)")
    .eq("status", "PENDING");
  const overdueFollowUps = overdueActionableFollowUps(
    (pendingRows ?? []) as unknown as { id: string; source: string; due_at: string; lead: { id: string } | null }[],
    (t) => ({ source: t.source, status: "PENDING", leadId: t.lead?.id ?? null, dueAt: t.due_at }),
    new Date()
  ).length;

  return (
    <AppShell fullName={appUser.full_name} overdueFollowUps={overdueFollowUps}>
      {children}
    </AppShell>
  );
}
