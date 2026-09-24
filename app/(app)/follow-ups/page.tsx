import type { Metadata } from "next";
import { AlertTriangle, CalendarClock, CalendarDays, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { FollowUpRow } from "@/components/follow-ups/follow-up-row";
import { isSameZonedCalendarDay } from "@/lib/crm/timezone";
import Link from "next/link";
import { UserX } from "lucide-react";
import { CreateFollowUpDialog } from "@/components/follow-ups/create-follow-up-dialog";
import {
  filterActionableFollowUps,
  openLeadsWithoutFollowUp,
  overdueActionableFollowUps,
} from "@/lib/crm/follow-up-visibility";
import { LEAD_STAGE_LABELS, type LeadStage } from "@/lib/crm/constants";
import { formatRelative } from "@/lib/crm/format";
import type { FollowUpWithRelations } from "@/lib/crm/types";

type UnscheduledLead = {
  id: string;
  stage: LeadStage;
  stage_changed_at: string;
  contact: { full_name: string } | null;
};

export const metadata: Metadata = { title: "מעקבים — GAL CRM" };
export const dynamic = "force-dynamic";

export default async function FollowUpsPage() {
  const supabase = await createClient();

  const [pendingRes, completedRes, openLeadsRes] = await Promise.all([
    supabase
      .from("follow_up_tasks")
      .select(
        `id, title, notes, due_at, status, completed_at, completed_note, source,
         lead:leads(id, stage, contact:contacts(id, full_name)),
         customer:customers(id, contact:contacts(id, full_name))`
      )
      .eq("status", "PENDING")
      .order("due_at", { ascending: true }),
    supabase
      .from("follow_up_tasks")
      .select(
        `id, title, notes, due_at, status, completed_at, completed_note, source,
         lead:leads(id, stage, contact:contacts(id, full_name)),
         customer:customers(id, contact:contacts(id, full_name))`
      )
      .eq("status", "COMPLETED")
      .order("completed_at", { ascending: false })
      .limit(20),
    supabase
      .from("leads")
      .select("id, stage, stage_changed_at, contact:contacts(full_name)")
      .not("stage", "in", "(WON,LOST)")
      .order("stage_changed_at", { ascending: true }),
  ]);

  const pendingRaw = (pendingRes.data ?? []) as unknown as FollowUpWithRelations[];
  const completed = (completedRes.data ?? []) as unknown as FollowUpWithRelations[];

  // Actionable-visibility rule: a lead with an active MANUAL follow-up
  // shows only that one here, never a competing AUTOMATIC row — see
  // lib/crm/follow-up-visibility.ts. "באיחור" uses the exact same
  // overdueActionableFollowUps rule as the sidebar badge
  // (app/(app)/layout.tsx), applied to the same FULL pending set.
  const visibilityInfo = (t: FollowUpWithRelations) => ({
    source: t.source,
    status: t.status,
    leadId: t.lead?.id ?? null,
    dueAt: t.due_at,
  });
  const pending = filterActionableFollowUps(pendingRaw, visibilityInfo);

  const now = new Date();
  // "Today" means Israel's calendar day, not the rendering server's own
  // (Vercel serverless functions default to UTC) — see
  // lib/crm/timezone.ts's own comment for why this matters most right
  // around midnight Israel time.
  const overdue = overdueActionableFollowUps(pendingRaw, visibilityInfo, now);
  const dueToday = pending.filter(
    (t) => new Date(t.due_at) >= now && isSameZonedCalendarDay(new Date(t.due_at), now)
  );
  const upcoming = pending.filter(
    (t) => new Date(t.due_at) >= now && !isSameZonedCalendarDay(new Date(t.due_at), now)
  );

  // Open leads with no pending follow-up at all: nothing will ever remind
  // Gal about them (e.g. leads already in progress whose AUTOMATIC task
  // was closed by the V2 transition), so they get their own section with
  // a one-click "מעקב חדש".
  const unscheduledLeads = openLeadsWithoutFollowUp(
    (openLeadsRes.data ?? []) as unknown as UnscheduledLead[],
    pendingRaw.map((t) => t.lead?.id)
  );

  const totalOpen = pending.length + unscheduledLeads.length;

  return (
    <div>
      <PageHeader
        title="מעקבים"
        description="כל מה שנשארת חייבת תשובה עליו — לליד או ללקוחה."
      />

      {totalOpen === 0 && completed.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="עדיין אין מעקבים"
          description="משימות מעקב שנוצרות מתוך ליד יופיעו כאן, לפי דחיפות."
        />
      ) : (
        <div className="space-y-8">
          <Section
            icon={AlertTriangle}
            iconClass="text-red-500"
            title="באיחור"
            count={overdue.length}
            tasks={overdue}
            tone="overdue"
            emptyText="שום דבר לא באיחור — הכול תחת שליטה."
          />
          {unscheduledLeads.length > 0 && (
            <section>
              <div className="mb-1 flex items-center gap-2">
                <UserX className="h-4 w-4 text-amber-500" />
                <h2 className="text-sm font-semibold text-zinc-900">לידים פתוחים בלי מעקב</h2>
                <span className="text-xs font-medium text-zinc-400">{unscheduledLeads.length}</span>
              </div>
              <p className="mb-3 text-xs text-zinc-500">
                לידים בטיפול שאין להם מעקב מתוכנן — לא תישלח עליהם שום תזכורת עד שייקבע מעקב.
              </p>
              <div className="space-y-2">
                {unscheduledLeads.map((lead) => (
                  <div
                    key={lead.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/leads/${lead.id}`}
                        className="block truncate text-sm font-medium text-zinc-900 hover:text-rose-600 hover:underline"
                      >
                        {lead.contact?.full_name ?? "ליד"}
                      </Link>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {LEAD_STAGE_LABELS[lead.stage]} · עודכן {formatRelative(lead.stage_changed_at)}
                      </p>
                    </div>
                    <CreateFollowUpDialog leadId={lead.id} />
                  </div>
                ))}
              </div>
            </section>
          )}
          <Section
            icon={CalendarDays}
            iconClass="text-amber-500"
            title="להיום"
            count={dueToday.length}
            tasks={dueToday}
            tone="today"
            emptyText="שום דבר לא נדרש היום."
          />
          <Section
            icon={CalendarClock}
            iconClass="text-zinc-400"
            title="קרובים"
            count={upcoming.length}
            tasks={upcoming}
            tone="upcoming"
            emptyText="שום דבר לא מתוכנן בהמשך."
          />
          <Section
            icon={CheckCircle2}
            iconClass="text-emerald-500"
            title="הושלמו לאחרונה"
            count={completed.length}
            tasks={completed}
            tone="done"
            emptyText="עדיין לא הושלם כלום."
            collapsedIfEmpty
          />
        </div>
      )}
    </div>
  );
}

function Section({
  icon: Icon,
  iconClass,
  title,
  count,
  tasks,
  tone,
  emptyText,
  collapsedIfEmpty,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  title: string;
  count: number;
  tasks: FollowUpWithRelations[];
  tone: "overdue" | "today" | "upcoming" | "done";
  emptyText: string;
  collapsedIfEmpty?: boolean;
}) {
  if (collapsedIfEmpty && count === 0) return null;

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Icon className={`h-4 w-4 ${iconClass}`} />
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
        <span className="text-xs font-medium text-zinc-400">{count}</span>
      </div>
      {tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-4 py-4 text-sm text-zinc-400">
          {emptyText}
        </p>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <FollowUpRow key={task.id} task={task} tone={tone} />
          ))}
        </div>
      )}
    </section>
  );
}
