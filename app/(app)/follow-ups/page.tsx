import type { Metadata } from "next";
import { AlertTriangle, CalendarClock, CalendarDays, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { FollowUpRow } from "@/components/follow-ups/follow-up-row";
import { isSameZonedCalendarDay } from "@/lib/crm/timezone";
import type { FollowUpWithRelations } from "@/lib/crm/types";

export const metadata: Metadata = { title: "מעקבים — GAL CRM" };
export const dynamic = "force-dynamic";

export default async function FollowUpsPage() {
  const supabase = await createClient();

  const [pendingRes, completedRes] = await Promise.all([
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
  ]);

  const pending = (pendingRes.data ?? []) as unknown as FollowUpWithRelations[];
  const completed = (completedRes.data ?? []) as unknown as FollowUpWithRelations[];

  const now = new Date();
  // "Today" means Israel's calendar day, not the rendering server's own
  // (Vercel serverless functions default to UTC) — see
  // lib/crm/timezone.ts's own comment for why this matters most right
  // around midnight Israel time.
  const overdue = pending.filter((t) => new Date(t.due_at) < now);
  const dueToday = pending.filter(
    (t) => new Date(t.due_at) >= now && isSameZonedCalendarDay(new Date(t.due_at), now)
  );
  const upcoming = pending.filter(
    (t) => new Date(t.due_at) >= now && !isSameZonedCalendarDay(new Date(t.due_at), now)
  );

  const totalOpen = pending.length;

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
