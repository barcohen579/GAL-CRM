import {
  UserPlus,
  ArrowRightLeft,
  MapPin,
  CalendarPlus,
  CheckCircle2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { TimelineEvent, TimelineEventType } from "@/lib/crm/types";
import { formatDateTime } from "@/lib/crm/format";

const ICONS: Record<TimelineEventType, LucideIcon> = {
  LEAD_CREATED: UserPlus,
  STAGE_CHANGED: ArrowRightLeft,
  TOUCHPOINT: MapPin,
  FOLLOW_UP_CREATED: CalendarPlus,
  FOLLOW_UP_COMPLETED: CheckCircle2,
  FOLLOW_UP_CANCELLED: XCircle,
};

const ICON_TONE: Record<TimelineEventType, string> = {
  LEAD_CREATED: "bg-rose-50 text-rose-600",
  STAGE_CHANGED: "bg-sky-50 text-sky-600",
  TOUCHPOINT: "bg-violet-50 text-violet-600",
  FOLLOW_UP_CREATED: "bg-zinc-100 text-zinc-500",
  FOLLOW_UP_COMPLETED: "bg-emerald-50 text-emerald-600",
  FOLLOW_UP_CANCELLED: "bg-red-50 text-red-500",
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-4 py-6 text-center text-sm text-zinc-400">
        עדיין אין פעילות לתעד.
      </p>
    );
  }

  return (
    <ol className="space-y-4">
      {events.map((event) => {
        const Icon = ICONS[event.type];
        return (
          <li key={event.id} className="flex items-start gap-3">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${ICON_TONE[event.type]}`}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-sm text-zinc-800">{event.title}</p>
              {event.description && (
                <p className="mt-0.5 text-xs text-zinc-500">{event.description}</p>
              )}
              <p className="mt-0.5 text-[11px] text-zinc-400">
                {formatDateTime(event.at)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
