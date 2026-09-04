// Builds a unified activity timeline purely by deriving it from rows
// that already exist in leads / lead_stage_events / follow_up_tasks /
// touchpoints. Deliberately NOT a stored table: every event here is a
// read-time projection of real data, so there is nothing to keep in
// sync and no way for the timeline to say something the underlying
// records don't. Purchases/payments will be folded in the same way
// later, per the design note in the report.

import type { LeadDetail, TimelineEvent } from "./types";
import {
  LEAD_STAGE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
  LEAD_LOST_REASON_LABELS,
  type LeadLostReason,
} from "./constants";

function isLeadLostReason(value: string): value is LeadLostReason {
  return value in LEAD_LOST_REASON_LABELS;
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
    // The reason lives on the event's own `note` (set at the moment of
    // the transition), NOT on the lead's current lost_reason — the lead
    // may since have been reopened, which clears that field. Reading
    // from the event keeps this entry accurate as permanent history.
    const isLost = ev.to_stage === "LOST";
    const lostReason = ev.note && isLeadLostReason(ev.note) ? ev.note : null;
    events.push({
      id: `stage-${ev.id}`,
      type: "STAGE_CHANGED",
      at: ev.changed_at,
      title: ev.from_stage
        ? `השלב השתנה מ"${LEAD_STAGE_LABELS[ev.from_stage]}" ל"${LEAD_STAGE_LABELS[ev.to_stage]}"`
        : `השלב נקבע ל"${LEAD_STAGE_LABELS[ev.to_stage]}"`,
      description:
        isLost && lostReason
          ? `סיבה: ${LEAD_LOST_REASON_LABELS[lostReason]}`
          : undefined,
    });
  }

  for (const task of lead.follow_up_tasks) {
    events.push({
      id: `task-created-${task.id}`,
      type: "FOLLOW_UP_CREATED",
      at: task.created_at,
      title: `נוצר מעקב: ${task.title}`,
    });

    if (task.status === "COMPLETED" && task.completed_at) {
      events.push({
        id: `task-completed-${task.id}`,
        type: "FOLLOW_UP_COMPLETED",
        at: task.completed_at,
        title: `מעקב הושלם: ${task.title}`,
        description: task.completed_note ?? undefined,
      });
    }

    if (task.status === "CANCELLED") {
      events.push({
        id: `task-cancelled-${task.id}`,
        // Cancellation has no dedicated timestamp column (completed_at is
        // DB-constrained to COMPLETED rows only — see
        // follow_up_tasks_completed_at_consistency). updated_at is bumped
        // by the set_updated_at trigger on every UPDATE, so it reflects
        // the actual cancellation time here; due_at would instead be
        // whenever the task had been due, misplacing this entry in the
        // timeline.
        type: "FOLLOW_UP_CANCELLED",
        at: task.updated_at,
        title: `מעקב בוטל: ${task.title}`,
        // Only set when the system, not Gal, auto-cancelled this
        // follow-up because the lead reached WON/LOST — a manual
        // "ביטול מעקב" leaves this null and shows no description here.
        description: task.auto_closed_reason ?? undefined,
      });
    }
  }

  return events.sort((a, b) => b.at.localeCompare(a.at));
}
