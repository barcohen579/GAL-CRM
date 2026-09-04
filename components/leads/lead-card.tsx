import Link from "next/link";
import { AtSign, Clock } from "lucide-react";
import type { LeadWithRelations } from "@/lib/crm/types";
import {
  SERVICE_TYPE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatRelative } from "@/lib/crm/format";
import { filterActionableFollowUps } from "@/lib/crm/follow-up-visibility";
import { LeadStageControl } from "./lead-stage-control";

export function LeadCard({ lead }: { lead: LeadWithRelations }) {
  const primaryTouchpoint =
    lead.touchpoints.find((t) => t.is_primary) ?? lead.touchpoints[0];

  // Actionable-visibility rule: don't show this lead's AUTOMATIC
  // follow-up's date here while an active MANUAL one already exists for
  // it — same rule as /follow-ups and the dashboard, see
  // lib/crm/follow-up-visibility.ts.
  const nextFollowUp = filterActionableFollowUps(
    lead.follow_up_tasks.filter((t) => t.status === "PENDING"),
    (t) => ({ source: t.source, status: t.status, leadId: lead.id })
  ).sort((a, b) => a.due_at.localeCompare(b.due_at))[0];

  const overdue = nextFollowUp ? new Date(nextFollowUp.due_at) < new Date() : false;
  const contactName = lead.contact?.full_name ?? "איש קשר לא ידוע";
  const href = `/leads/${lead.id}`;
  const interestedServiceTypes = lead.interested_services.map((s) => s.service_type);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3.5 shadow-sm transition-shadow hover:shadow-md">
      {/* The stage control renders buttons/dialogs of its own, so it sits
          as a SIBLING of the details link rather than nested inside it —
          nesting interactive controls inside an <a> is invalid HTML and
          risks accessibility/hydration issues. */}
      <div className="flex items-start justify-between gap-2">
        <Link href={href} className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900 hover:text-rose-600">
            {contactName}
          </p>
        </Link>
        <LeadStageControl
          leadId={lead.id}
          stage={lead.stage}
          contactName={contactName}
          interestedServices={interestedServiceTypes}
        />
      </div>

      <Link href={href} className="block">
        {interestedServiceTypes.length > 0 && (
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {interestedServiceTypes.map((s) => SERVICE_TYPE_LABELS[s]).join(", ")}
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-zinc-500">
          {primaryTouchpoint && (
            <span className="inline-flex items-center gap-1">
              <AtSign className="h-3 w-3" strokeWidth={2} />
              {TOUCHPOINT_CHANNEL_LABELS[primaryTouchpoint.channel]}
            </span>
          )}
          <span>{formatDate(lead.created_at)}</span>
        </div>

        {nextFollowUp && (
          <div
            className={`mt-2.5 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium ${
              overdue ? "bg-red-50 text-red-700" : "bg-zinc-50 text-zinc-600"
            }`}
          >
            <Clock className="h-3 w-3" strokeWidth={2} />
            {overdue ? "באיחור: " : "הבא: "}
            {formatRelative(nextFollowUp.due_at)}
          </div>
        )}
      </Link>
    </div>
  );
}
