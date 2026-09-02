import { AtSign, Clock } from "lucide-react";
import type { LeadWithRelations } from "@/lib/crm/types";
import {
  SERVICE_TYPE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatRelative } from "@/lib/crm/format";

export function LeadCard({ lead }: { lead: LeadWithRelations }) {
  const primaryTouchpoint =
    lead.touchpoints.find((t) => t.is_primary) ?? lead.touchpoints[0];

  const nextFollowUp = lead.follow_up_tasks
    .filter((t) => t.status === "PENDING")
    .sort((a, b) => a.due_at.localeCompare(b.due_at))[0];

  const overdue = nextFollowUp ? new Date(nextFollowUp.due_at) < new Date() : false;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3.5 shadow-sm transition-shadow hover:shadow-md">
      <p className="truncate text-sm font-semibold text-zinc-900">
        {lead.contact?.full_name ?? "איש קשר לא ידוע"}
      </p>

      {lead.interested_service && (
        <p className="mt-0.5 truncate text-xs text-zinc-500">
          {SERVICE_TYPE_LABELS[lead.interested_service]}
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
            overdue
              ? "bg-red-50 text-red-700"
              : "bg-zinc-50 text-zinc-600"
          }`}
        >
          <Clock className="h-3 w-3" strokeWidth={2} />
          {overdue ? "באיחור: " : "הבא: "}
          {formatRelative(nextFollowUp.due_at)}
        </div>
      )}
    </div>
  );
}
