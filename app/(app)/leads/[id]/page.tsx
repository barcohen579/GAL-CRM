import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowRight,
  Phone,
  Mail,
  AtSign,
  StickyNote,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  MessageCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LeadStageControl } from "@/components/leads/lead-stage-control";
import { DeleteLeadButton } from "@/components/leads/delete-lead-button";
import { ConversationUpdateButton } from "@/components/leads/conversation-update-dialog";
import { CreateFollowUpDialog } from "@/components/follow-ups/create-follow-up-dialog";
import { FollowUpTaskActions } from "@/components/follow-ups/follow-up-task-actions";
import { Timeline } from "@/components/leads/timeline";
import { buildLeadTimeline, stageEventLostReason } from "@/lib/crm/timeline";
import {
  filterActionableFollowUps,
  followUpDisplayTitle,
} from "@/lib/crm/follow-up-visibility";
import {
  LEAD_CONVERSATION_OUTCOME_LABELS,
  LEAD_LOST_REASON_LABELS,
  LEAD_STAGE_LABELS,
  SERVICE_TYPE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatDateTime, formatRelative } from "@/lib/crm/format";
import { buildWhatsAppUrl } from "@/lib/notifications/reminder-logic";
import type { FollowUpTask, LeadDetail } from "@/lib/crm/types";

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
      `id, stage, stage_changed_at, lost_reason, lost_reason_note, created_at, updated_at,
       interested_services:lead_interested_services(service_type),
       contact:contacts(
         id, full_name, phone, email, instagram_username, notes,
         referral:referrals(
           referrer_customer_id,
           referrer:customers(id, contact:contacts(full_name))
         )
       ),
       touchpoints(id, channel, certainty, source_detail, is_primary, occurred_at, created_at),
       follow_up_tasks(id, title, notes, due_at, status, completed_at, completed_note, auto_closed_reason, source, created_at, updated_at),
       stage_events:lead_stage_events(id, from_stage, to_stage, changed_at, note, lost_reason, lost_reason_note),
       conversation_updates:lead_conversation_updates(id, outcome, note, stage_before, stage_after, follow_up_task_id, created_at)`
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !data || !data.contact) {
    notFound();
  }

  const lead = data as unknown as LeadDetail;
  const timeline = buildLeadTimeline(lead);
  const now = new Date();
  const isOpen = lead.stage !== "WON" && lead.stage !== "LOST";

  // Actionable-visibility rule: while this lead has an active MANUAL
  // follow-up, a still-pending AUTOMATIC one is never shown as a second
  // actionable item (same rule as /follow-ups, the dashboard and the
  // sidebar badge — lib/crm/follow-up-visibility.ts).
  const pendingFollowUps = filterActionableFollowUps(
    lead.follow_up_tasks.filter((t) => t.status === "PENDING"),
    (t) => ({ source: t.source, status: t.status, leadId: lead.id })
  ).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const currentFollowUp = pendingFollowUps[0] ?? null;
  const pastFollowUps = lead.follow_up_tasks
    .filter((t) => t.status !== "PENDING")
    .sort((a, b) => (b.completed_at ?? b.updated_at).localeCompare(a.completed_at ?? a.updated_at));

  const conversations = [...(lead.conversation_updates ?? [])].sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );
  const latestConversation = conversations[0] ?? null;

  const latestLostEvent = [...lead.stage_events]
    .filter((e) => e.to_stage === "LOST")
    .sort((a, b) => b.changed_at.localeCompare(a.changed_at))[0];
  const lostReason = lead.lost_reason ?? (latestLostEvent ? stageEventLostReason(latestLostEvent) : null);
  const whatsappUrl = buildWhatsAppUrl(lead.contact.phone);

  return (
    <div>
      <Link
        href="/leads"
        className="mb-4 flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-rose-600"
      >
        <ArrowRight className="h-3.5 w-3.5" />
        חזרה ללידים
      </Link>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            {lead.contact.full_name}
          </h1>
          <LeadStageControl
            leadId={lead.id}
            stage={lead.stage}
            contactName={lead.contact.full_name}
            interestedServices={lead.interested_services.map((s) => s.service_type)}
            size="md"
          />
        </div>
        <DeleteLeadButton leadId={lead.id} />
      </div>

      {/* 1. What needs to happen now */}
      <NextActionCard
        stage={lead.stage}
        currentFollowUp={currentFollowUp}
        lostReasonLabel={lostReason ? LEAD_LOST_REASON_LABELS[lostReason] : null}
        lostReasonNote={lead.lost_reason_note ?? latestLostEvent?.lost_reason_note ?? null}
        now={now}
      />

      <div className="mt-4 flex flex-wrap gap-2">
        {isOpen && <ConversationUpdateButton leadId={lead.id} currentStage={lead.stage} />}
        {whatsappUrl && (
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <MessageCircle className="h-4 w-4" />
            WhatsApp
          </a>
        )}
        {lead.contact.phone && (
          <a
            href={`tel:${lead.contact.phone}`}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <Phone className="h-4 w-4" />
            התקשרות
          </a>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* 2. Latest conversation */}
          <Card>
            <CardHeader title="שיחה אחרונה" />
            <div className="px-5 py-4">
              {latestConversation ? (
                <div>
                  <p className="text-sm font-semibold text-zinc-900">
                    {LEAD_CONVERSATION_OUTCOME_LABELS[latestConversation.outcome] ?? latestConversation.outcome}
                  </p>
                  {latestConversation.note && (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">
                      {latestConversation.note}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-zinc-400">
                    {formatDateTime(latestConversation.created_at)}
                    {latestConversation.stage_before !== latestConversation.stage_after &&
                      ` · השלב עודכן ל"${LEAD_STAGE_LABELS[latestConversation.stage_after]}"`}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-zinc-400">עדיין לא תועדה שיחה עם הליד הזה.</p>
              )}
            </div>
            {conversations.length > 1 && (
              <details className="border-t border-zinc-100 px-5 py-3">
                <summary className="cursor-pointer text-xs font-medium text-zinc-500">
                  שיחות קודמות ({conversations.length - 1})
                </summary>
                <ul className="mt-3 space-y-3">
                  {conversations.slice(1).map((c) => (
                    <li key={c.id}>
                      <p className="text-sm text-zinc-800">
                        {LEAD_CONVERSATION_OUTCOME_LABELS[c.outcome] ?? c.outcome}
                      </p>
                      {c.note && (
                        <p className="whitespace-pre-wrap text-xs text-zinc-600">{c.note}</p>
                      )}
                      <p className="text-[11px] text-zinc-400">{formatDateTime(c.created_at)}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          {/* 3. Follow-ups: current, then previous */}
          <Card>
            <CardHeader
              title="מעקב נוכחי"
              description={
                currentFollowUp ? `הבא: ${formatRelative(currentFollowUp.due_at)}` : "אין מעקב פתוח"
              }
              action={isOpen ? <CreateFollowUpDialog leadId={lead.id} /> : undefined}
            />
            {pendingFollowUps.length === 0 ? (
              <p className="px-5 py-5 text-sm text-zinc-400">
                {isOpen ? "אין מעקב פתוח לליד הזה." : "הליד סגור — אין מעקבים פתוחים."}
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {pendingFollowUps.map((task) => {
                  const overdue = new Date(task.due_at) < now;
                  return (
                    <li key={task.id} className="flex items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-900">{followUpDisplayTitle(task)}</p>
                        {task.notes && (
                          <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-500">{task.notes}</p>
                        )}
                        <p className={`mt-1 text-xs font-medium ${overdue ? "text-red-600" : "text-zinc-500"}`}>
                          {overdue ? "באיחור: " : ""}
                          {formatDateTime(task.due_at)}
                        </p>
                      </div>
                      <FollowUpTaskActions taskId={task.id} leadId={lead.id} />
                    </li>
                  );
                })}
              </ul>
            )}

            {pastFollowUps.length > 0 && (
              <details className="border-t border-zinc-100 px-5 py-3">
                <summary className="cursor-pointer text-xs font-medium text-zinc-500">
                  מעקבים קודמים ({pastFollowUps.length})
                </summary>
                <ul className="mt-3 space-y-3">
                  {pastFollowUps.map((task) => (
                    <li key={task.id} className="opacity-80">
                      <p className="text-sm text-zinc-500 line-through">{followUpDisplayTitle(task)}</p>
                      <p className="mt-0.5 text-xs text-zinc-400">
                        {task.status === "COMPLETED" ? "הושלם" : "בוטל"} ·{" "}
                        {formatDateTime(task.completed_at ?? task.updated_at)}
                      </p>
                      {task.completed_note && (
                        <p className="mt-0.5 text-xs text-emerald-700">{task.completed_note}</p>
                      )}
                      {task.auto_closed_reason && (
                        <p className="mt-0.5 text-xs text-zinc-400">{task.auto_closed_reason}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          {/* 4. Lead details */}
          <Card>
            <CardHeader title="פרטי הליד" />
            <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
              <Field label="שירותים שמעניינים אותה">
                {lead.interested_services.length > 0 ? (
                  <span className="inline-flex flex-wrap gap-1.5">
                    {lead.interested_services.map((s) => (
                      <Badge key={s.service_type} tone="neutral">
                        {SERVICE_TYPE_LABELS[s.service_type]}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "לא צוין"
                )}
              </Field>
              <Field label="נוצר בתאריך">{formatDate(lead.created_at)}</Field>
              <Field label="שינוי שלב אחרון">{formatDateTime(lead.stage_changed_at)}</Field>
              {lead.contact.referral && (
                <Field label="הופנתה על ידי">
                  {lead.contact.referral.referrer ? (
                    <Link
                      href={`/customers/${lead.contact.referral.referrer.id}`}
                      className="text-rose-600 hover:underline"
                    >
                      {lead.contact.referral.referrer.contact?.full_name ?? "לקוחה"}
                    </Link>
                  ) : (
                    "הפניה (לא ידוע על ידי מי)"
                  )}
                </Field>
              )}
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
                <p className="whitespace-pre-wrap text-sm text-zinc-700">{lead.contact.notes}</p>
              </div>
            )}
          </Card>
        </div>

        {/* 5. Full history */}
        <div>
          <Card>
            <CardHeader title="היסטוריה" description="שלבים, שיחות ומעקבים — כל מה שקרה עם הליד" />
            <div className="px-5 py-4">
              <Timeline events={timeline} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function NextActionCard({
  stage,
  currentFollowUp,
  lostReasonLabel,
  lostReasonNote,
  now,
}: {
  stage: LeadDetail["stage"];
  currentFollowUp: FollowUpTask | null;
  lostReasonLabel: string | null;
  lostReasonNote: string | null;
  now: Date;
}) {
  let tone: "done" | "urgent" | "scheduled" | "attention";
  let title: string;
  let detail: string | null = null;

  if (stage === "WON") {
    tone = "done";
    title = "הליד נסגר — אין פעולה נדרשת";
  } else if (stage === "LOST") {
    tone = "done";
    title = "הליד סומן כלא נסגרה";
    detail = [lostReasonLabel ? `סיבה: ${lostReasonLabel}` : null, lostReasonNote].filter(Boolean).join(" — ") || null;
  } else if (currentFollowUp) {
    const overdue = new Date(currentFollowUp.due_at) < now;
    const isAutomatic = currentFollowUp.source === "AUTOMATIC";
    tone = overdue ? "urgent" : "scheduled";
    title = isAutomatic
      ? overdue
        ? "ליד חדש — עדיין לא נוצר קשר"
        : "ליד חדש — מחכה ליצירת קשר ראשון"
      : overdue
        ? `מעקב באיחור: ${followUpDisplayTitle(currentFollowUp)}`
        : `המעקב הבא: ${followUpDisplayTitle(currentFollowUp)}`;
    detail = isAutomatic
      ? overdue
        ? "עדכני שיחה או צרי מעקב כדי לסמן שהליד בטיפול."
        : `תזכורת אחת תישלח ב-${formatDateTime(currentFollowUp.due_at)} אם עדיין לא יהיה טיפול.`
      : `${overdue ? "היה אמור להתבצע" : "מתוכנן ל"} ${formatDateTime(currentFollowUp.due_at)}`;
  } else {
    tone = "attention";
    title = "אין מעקב מתוכנן";
    detail = "הליד פתוח — כדאי לעדכן שיחה או לקבוע מעקב.";
  }

  const styles = {
    done: { box: "border-emerald-200 bg-emerald-50", icon: CheckCircle2, iconClass: "text-emerald-600" },
    urgent: { box: "border-red-200 bg-red-50", icon: AlertTriangle, iconClass: "text-red-600" },
    scheduled: { box: "border-sky-200 bg-sky-50", icon: CalendarClock, iconClass: "text-sky-600" },
    attention: { box: "border-amber-200 bg-amber-50", icon: CircleAlert, iconClass: "text-amber-600" },
  }[tone];
  const Icon = styles.icon;

  return (
    <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3 ${styles.box}`}>
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${styles.iconClass}`} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-zinc-900">{title}</p>
        {detail && <p className="mt-0.5 text-xs text-zinc-600">{detail}</p>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <div className="mt-0.5 text-sm text-zinc-800">{children}</div>
    </div>
  );
}
