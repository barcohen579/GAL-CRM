// Builds a unified activity timeline purely by deriving it from rows
// that already exist in leads / lead_stage_events / follow_up_tasks /
// touchpoints / lead_conversation_updates. Deliberately NOT a stored
// table: every event here is a read-time projection of real data, so
// there is nothing to keep in sync and no way for the timeline to say
// something the underlying records don't.

import type { LeadDetail, StageEvent, TimelineEvent } from "./types.ts";
import {
  LEAD_STAGE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
  LEAD_LOST_REASON_LABELS,
  LEAD_CONVERSATION_OUTCOME_LABELS,
  isLeadLostReason,
  type LeadLostReason,
} from "./constants.ts";
import { followUpDisplayTitle } from "./follow-up-visibility.ts";

/** The LOST reason recorded ON the stage event itself (immutable
 *  history — survives the lead being reopened later). V2 rows carry the
 *  structured `lost_reason`; pre-V2 rows carry the code in `note`. Never
 *  falls back to the lead's CURRENT lost_reason. */
export function stageEventLostReason(ev: StageEvent): LeadLostReason | null {
  if (ev.to_stage !== "LOST") return null;
  if (ev.lost_reason && isLeadLostReason(ev.lost_reason)) return ev.lost_reason;
  if (ev.note && isLeadLostReason(ev.note)) return ev.note;
  return null;
}

export function buildLeadTimeline(lead: LeadDetail): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  events.push({
    id: `lead-created-${lead.id}`,
    type: "LEAD_CREATED",
    at: lead.created_at,
    title: "הליד נוצר",
  });

  for (const tp of lead.touchpoints) {
    events.push({
      id: `touchpoint-${tp.id}`,
      type: "TOUCHPOINT",
      at: tp.occurred_at ?? tp.created_at,
      title: `מקור: ${TOUCHPOINT_CHANNEL_LABELS[tp.channel]}${tp.is_primary ? " (עיקרי)" : ""}`,
      description: tp.source_detail ?? undefined,
    });
  }

  for (const ev of lead.stage_events) {
    const lostReason = stageEventLostReason(ev);
    const lostParts: string[] = [];
    if (lostReason) lostParts.push(`סיבה: ${LEAD_LOST_REASON_LABELS[lostReason]}`);
    if (ev.to_stage === "LOST" && ev.lost_reason_note) lostParts.push(ev.lost_reason_note);
    events.push({
      id: `stage-${ev.id}`,
      type: "STAGE_CHANGED",
      at: ev.changed_at,
      title: ev.from_stage
        ? `השלב השתנה מ"${LEAD_STAGE_LABELS[ev.from_stage]}" ל"${LEAD_STAGE_LABELS[ev.to_stage]}"`
        : `השלב נקבע ל"${LEAD_STAGE_LABELS[ev.to_stage]}"`,
      description: lostParts.length > 0 ? lostParts.join(" — ") : undefined,
    });
  }

  const tasksById = new Map(lead.follow_up_tasks.map((t) => [t.id, t]));

  for (const cu of lead.conversation_updates ?? []) {
    const parts: string[] = [];
    if (cu.note) parts.push(cu.note);
    const linkedTask = cu.follow_up_task_id ? tasksById.get(cu.follow_up_task_id) : undefined;
    if (linkedTask) parts.push(`נוצר מעקב: ${followUpDisplayTitle(linkedTask)}`);
    events.push({
      id: `conversation-${cu.id}`,
      type: "CONVERSATION",
      at: cu.created_at,
      title: `עדכון שיחה: ${LEAD_CONVERSATION_OUTCOME_LABELS[cu.outcome] ?? cu.outcome}`,
      description: parts.length > 0 ? parts.join(" · ") : undefined,
    });
  }

  for (const task of lead.follow_up_tasks) {
    const title = followUpDisplayTitle(task);
    events.push({
      id: `task-created-${task.id}`,
      type: "FOLLOW_UP_CREATED",
      at: task.created_at,
      title: `נוצר מעקב: ${title}`,
    });

    if (task.status === "COMPLETED" && task.completed_at) {
      events.push({
        id: `task-completed-${task.id}`,
        type: "FOLLOW_UP_COMPLETED",
        at: task.completed_at,
        title: `מעקב הושלם: ${title}`,
        description: task.completed_note ?? undefined,
      });
    }

    if (task.status === "CANCELLED") {
      events.push({
        id: `task-cancelled-${task.id}`,
        // Cancellation has no dedicated timestamp column (completed_at is
        // DB-constrained to COMPLETED rows only). updated_at is bumped by
        // the set_updated_at trigger on every UPDATE, so it reflects the
        // actual cancellation time.
        type: "FOLLOW_UP_CANCELLED",
        at: task.updated_at,
        title: `מעקב בוטל: ${title}`,
        // Only set when the system (not Gal) closed this follow-up.
        description: task.auto_closed_reason ?? undefined,
      });
    }
  }

  return events.sort((a, b) => b.at.localeCompare(a.at));
}
