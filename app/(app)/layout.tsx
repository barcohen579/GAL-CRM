import { redirect } from "next/navigation";
import { getCrmUser } from "@/lib/supabase/get-crm-user";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { filterActionableFollowUps } from "@/lib/crm/follow-up-visibility";

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

  // Layout-wide signal for the sidebar's overdue badge. Was a plain
  // head:true count; now fetches the (source, lead id) each row needs
  // so the Automatic Lead Follow-Up Escalation Loop's actionable-
  // visibility rule (lib/crm/follow-up-visibility.ts — a lead's
  // AUTOMATIC follow-up never counts here while it also has an active
  // MANUAL one) can be applied before counting. Still cheap at this
  // CRM's real scale (a single studio's own lead volume, not a bulk
  // count query justification).
  const supabase = await createClient();
  const { data: overdueFollowUpRows } = await supabase
    .from("follow_up_tasks")
    .select("id, source, lead:leads(id)")
    .eq("status", "PENDING")
    .lt("due_at", new Date().toISOString());
  const overdueFollowUps = filterActionableFollowUps(
    (overdueFollowUpRows ?? []) as unknown as { id: string; source: string; lead: { id: string } | null }[],
    (t) => ({ source: t.source, status: "PENDING", leadId: t.lead?.id ?? null })
  ).length;

  return (
    <AppShell fullName={appUser.full_name} overdueFollowUps={overdueFollowUps}>
      {children}
    </AppShell>
  );
}
