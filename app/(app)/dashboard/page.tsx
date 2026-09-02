import type { Metadata } from "next";
import Link from "next/link";
import {
  UserPlus,
  Clock,
  Dumbbell,
  Trophy,
  Wallet,
  TrendingUp,
  ArrowLeft,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  LEAD_STAGE_LABELS,
  LEAD_STAGE_TONE,
  SERVICE_TYPE_LABELS,
} from "@/lib/crm/constants";
import {
  formatDate,
  formatMoney,
  formatRelative,
  startOfMonthISO,
} from "@/lib/crm/format";
import type { LeadStage, ServiceType } from "@/lib/crm/constants";

export const metadata: Metadata = { title: "לוח בקרה — GAL CRM" };
export const dynamic = "force-dynamic";

type RecentLead = {
  id: string;
  stage: LeadStage;
  interested_service: ServiceType | null;
  created_at: string;
  contact: { full_name: string } | null;
};

type UpcomingFollowUp = {
  id: string;
  title: string;
  due_at: string;
  lead: { contact: { full_name: string } | null } | null;
  customer: { contact: { full_name: string } | null } | null;
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const monthStart = startOfMonthISO();
  const nowIso = new Date().toISOString();

  const [
    newLeadsRes,
    followUpsDueRes,
    trialsBookedRes,
    wonThisMonthRes,
    paymentsThisMonthRes,
    wonAllTimeRes,
    lostAllTimeRes,
    recentLeadsRes,
    upcomingFollowUpsRes,
  ] = await Promise.all([
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("stage", "NEW"),
    supabase
      .from("follow_up_tasks")
      .select("id", { count: "exact", head: true })
      .eq("status", "PENDING")
      .lte("due_at", nowIso),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("stage", "TRIAL_BOOKED"),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("stage", "WON")
      .gte("stage_changed_at", monthStart),
    supabase
      .from("payments")
      .select("amount")
      .eq("status", "PAID")
      .gte("paid_at", monthStart.slice(0, 10)),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("stage", "WON"),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("stage", "LOST"),
    supabase
      .from("leads")
      .select(
        "id, stage, interested_service, created_at, contact:contacts(full_name)"
      )
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("follow_up_tasks")
      .select(
        "id, title, due_at, lead:leads(contact:contacts(full_name)), customer:customers(contact:contacts(full_name))"
      )
      .eq("status", "PENDING")
      .order("due_at", { ascending: true })
      .limit(5),
  ]);

  const revenueThisMonth = (paymentsThisMonthRes.data ?? []).reduce(
    (sum, p) => sum + p.amount,
    0
  );

  const wonCount = wonAllTimeRes.count ?? 0;
  const lostCount = lostAllTimeRes.count ?? 0;
  const decidedCount = wonCount + lostCount;
  const conversionRate =
    decidedCount > 0 ? Math.round((wonCount / decidedCount) * 100) : null;

  const recentLeads = (recentLeadsRes.data ?? []) as unknown as RecentLead[];
  const upcomingFollowUps = (upcomingFollowUpsRes.data ??
    []) as unknown as UpcomingFollowUp[];

  return (
    <div>
      <PageHeader
        title="לוח בקרה"
        description="תמונת מצב חיה של לידים, מעקבים והכנסות."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="לידים חדשים"
          value={String(newLeadsRes.count ?? 0)}
          icon={UserPlus}
          tone="accent"
        />
        <StatCard
          label="מעקבים לביצוע"
          value={String(followUpsDueRes.count ?? 0)}
          icon={Clock}
        />
        <StatCard
          label="אימוני ניסיון שנקבעו"
          value={String(trialsBookedRes.count ?? 0)}
          icon={Dumbbell}
        />
        <StatCard
          label="נסגרו החודש"
          value={String(wonThisMonthRes.count ?? 0)}
          icon={Trophy}
        />
        <StatCard
          label="הכנסות החודש"
          value={formatMoney(revenueThisMonth)}
          icon={Wallet}
        />
        <StatCard
          label="אחוז סגירה"
          value={conversionRate === null ? "—" : `${conversionRate}%`}
          icon={TrendingUp}
          hint={
            decidedCount === 0
              ? "עדיין אין לידים שנסגרו או לא נסגרו"
              : `${wonCount} נסגרו מתוך ${decidedCount} שהוכרעו`
          }
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="לידים אחרונים"
            action={
              <Link
                href="/leads"
                className="flex items-center gap-1 text-xs font-medium text-rose-600 hover:text-rose-700"
              >
                לכל הלידים <ArrowLeft className="h-3.5 w-3.5" />
              </Link>
            }
          />
          {recentLeads.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={UserPlus}
                title="עדיין אין לידים"
                description="פניות חדשות יופיעו כאן ברגע שיתווספו."
              />
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {recentLeads.map((lead) => (
                <li
                  key={lead.id}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {lead.contact?.full_name ?? "איש קשר לא ידוע"}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {lead.interested_service
                        ? SERVICE_TYPE_LABELS[lead.interested_service]
                        : "לא צוין שירות"}{" "}
                      · {formatDate(lead.created_at)}
                    </p>
                  </div>
                  <Badge tone={LEAD_STAGE_TONE[lead.stage]}>
                    {LEAD_STAGE_LABELS[lead.stage]}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="מעקבים קרובים"
            action={
              <Link
                href="/follow-ups"
                className="flex items-center gap-1 text-xs font-medium text-rose-600 hover:text-rose-700"
              >
                לכל המעקבים <ArrowLeft className="h-3.5 w-3.5" />
              </Link>
            }
          />
          {upcomingFollowUps.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={Clock}
                title="שום דבר לא מתוכנן"
                description="מעקבים שתיצרי יופיעו כאן, מהקרוב ביותר."
              />
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {upcomingFollowUps.map((task) => {
                const overdue = new Date(task.due_at) < new Date();
                const name =
                  task.lead?.contact?.full_name ??
                  task.customer?.contact?.full_name ??
                  "לא ידוע";
                return (
                  <li
                    key={task.id}
                    className="flex items-center justify-between gap-3 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {task.title}
                      </p>
                      <p className="truncate text-xs text-zinc-500">{name}</p>
                    </div>
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        overdue ? "text-red-600" : "text-zinc-500"
                      }`}
                    >
                      {formatRelative(task.due_at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
