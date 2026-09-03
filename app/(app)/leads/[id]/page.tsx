import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Phone, Mail, AtSign, StickyNote } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LeadStageControl } from "@/components/leads/lead-stage-control";
import { DeleteLeadButton } from "@/components/leads/delete-lead-button";
import { CreateFollowUpDialog } from "@/components/follow-ups/create-follow-up-dialog";
import { FollowUpTaskActions } from "@/components/follow-ups/follow-up-task-actions";
import { Timeline } from "@/components/leads/timeline";
import { buildLeadTimeline } from "@/lib/crm/timeline";
import {
  SERVICE_TYPE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatDateTime, formatRelative } from "@/lib/crm/format";
import type { LeadDetail } from "@/lib/crm/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `ליד — GAL CRM`, description: id };
}

export default async function LeadDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("leads")
    .select(
      `id, stage, stage_changed_at, interested_service, lost_reason, created_at, updated_at,
       contact:contacts(id, full_name, phone, email, instagram_username, notes),
       touchpoints(id, channel, certainty, source_detail, is_primary, occurred_at, created_at),
       follow_up_tasks(id, title, notes, due_at, status, completed_at, completed_note, source, created_at, updated_at),
       stage_events:lead_stage_events(id, from_stage, to_stage, changed_at, note)`
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !data || !data.contact) {
    notFound();
  }

  const lead = data as unknown as LeadDetail;
  const timeline = buildLeadTimeline(lead);

  const pendingFollowUps = lead.follow_up_tasks
    .filter((t) => t.status === "PENDING")
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
  const nextFollowUp = pendingFollowUps[0];
  const pastFollowUps = lead.follow_up_tasks
    .filter((t) => t.status !== "PENDING")
    .sort((a, b) => b.due_at.localeCompare(a.due_at));

  return (
    <div>
      <Link
        href="/leads"
        className="mb-4 flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-rose-600"
      >
        <ArrowRight className="h-3.5 w-3.5" />
        חזרה ללידים
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            {lead.contact.full_name}
          </h1>
          <LeadStageControl
            leadId={lead.id}
            stage={lead.stage}
            contactName={lead.contact.full_name}
            size="md"
          />
        </div>
        <DeleteLeadButton leadId={lead.id} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Details column */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="פרטי הליד" />
            <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
              <Field label="שירות שמעניין אותה">
                {lead.interested_service
                  ? SERVICE_TYPE_LABELS[lead.interested_service]
                  : "לא צוין"}
              </Field>
              <Field label="נוצר בתאריך">{formatDate(lead.created_at)}</Field>
              <Field label="שינוי שלב אחרון">
                {formatDateTime(lead.stage_changed_at)}
              </Field>
              {lead.contact.phone && (
                <Field label="טלפון">
                  <span dir="ltr" className="flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-zinc-400" />
                    {lead.contact.phone}
                  </span>
                </Field>
              )}
              {lead.contact.email && (
                <Field label="אימייל">
                  <span dir="ltr" className="flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5 text-zinc-400" />
                    {lead.contact.email}
                  </span>
                </Field>
              )}
              {lead.contact.instagram_username && (
                <Field label="אינסטגרם">
                  <span dir="ltr" className="flex items-center gap-1.5">
                    <AtSign className="h-3.5 w-3.5 text-zinc-400" />
                    {lead.contact.instagram_username}
                  </span>
                </Field>
              )}
            </div>

            {lead.touchpoints.length > 0 && (
              <div className="border-t border-zinc-100 px-5 py-4">
                <p className="mb-2 text-xs font-medium text-zinc-500">מקורות / נקודות מגע</p>
                <div className="flex flex-wrap gap-2">
                  {lead.touchpoints.map((tp) => (
                    <Badge key={tp.id} tone={tp.is_primary ? "info" : "neutral"}>
                      {TOUCHPOINT_CHANNEL_LABELS[tp.channel]}
                      {tp.is_primary ? " (עיקרי)" : ""}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {lead.contact.notes && (
              <div className="border-t border-zinc-100 px-5 py-4">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                  <StickyNote className="h-3.5 w-3.5" /> הערות
                </p>
                <p className="whitespace-pre-wrap text-sm text-zinc-700">
                  {lead.contact.notes}
                </p>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="מעקבים"
              description={
                nextFollowUp
                  ? `הבא: ${formatRelative(nextFollowUp.due_at)}`
                  : "אין מעקב פתוח"
              }
              action={<CreateFollowUpDialog leadId={lead.id} />}
            />
            {pendingFollowUps.length === 0 && pastFollowUps.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-zinc-400">
                עדיין לא נוצרו מעקבים לליד הזה.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {pendingFollowUps.map((task) => {
                  const overdue = new Date(task.due_at) < new Date();
                  return (
                    <li key={task.id} className="flex items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-900">
                          {task.title}
                        </p>
                        {task.notes && (
                          <p className="mt-0.5 truncate text-xs text-zinc-500">{task.notes}</p>
                        )}
                        <p
                          className={`mt-1 text-xs font-medium ${overdue ? "text-red-600" : "text-zinc-500"}`}
                        >
                          {overdue ? "באיחור: " : ""}
                          {formatDateTime(task.due_at)}
                        </p>
                      </div>
                      <FollowUpTaskActions taskId={task.id} leadId={lead.id} />
                    </li>
                  );
                })}
                {pastFollowUps.map((task) => (
                  <li key={task.id} className="px-5 py-3 opacity-70">
                    <p
                      className={`truncate text-sm font-medium ${
                        task.status === "COMPLETED"
                          ? "text-zinc-500 line-through"
                          : "text-zinc-400 line-through"
                      }`}
                    >
                      {task.title}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-400">
                      {task.status === "COMPLETED" ? "הושלם" : "בוטל"} ·{" "}
                      {formatDateTime(task.completed_at ?? task.due_at)}
                    </p>
                    {task.completed_note && (
                      <p className="mt-0.5 text-xs text-emerald-700">
                        {task.completed_note}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Timeline column */}
        <div>
          <Card>
            <CardHeader title="ציר פעילות" description="כל מה שקרה עם הליד הזה" />
            <div className="px-5 py-4">
              <Timeline events={timeline} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-0.5 text-sm text-zinc-800">{children}</p>
    </div>
  );
}
