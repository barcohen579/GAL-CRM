// Supabase (service_role) implementation of ReminderRepo — see
// lib/notifications/reminder-job.ts for the contract. Only ids, counts
// and sanitized provider errors are ever written back; no contact data.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimedReminder, ReminderContext, ReminderRepo } from "./reminder-job.ts";
import type { LeadStage, ServiceType, TouchpointChannel } from "../crm/constants.ts";

// Mirrors the constants the SQL claim is called with — kept here, next to
// the only call site, and documented in docs/follow-up-notifications.md.
export const REMINDER_MAX_ATTEMPTS = 5;
export const REMINDER_RETRY_BACKOFF_MINUTES = 30;
export const REMINDER_STALE_SENDING_MINUTES = 15;

type TaskRow = {
  id: string;
  title: string;
  notes: string | null;
  due_at: string;
  status: ReminderContext["status"];
  source: ReminderContext["source"];
  lead: {
    id: string;
    stage: LeadStage;
    created_at: string;
    contact: { full_name: string; phone: string | null } | null;
    interested_services: { service_type: ServiceType }[] | null;
    touchpoints: { channel: TouchpointChannel; is_primary: boolean }[] | null;
  } | null;
  customer: { id: string; contact: { full_name: string; phone: string | null } | null } | null;
};

export function createSupabaseReminderRepo(supabase: SupabaseClient): ReminderRepo {
  async function finish(claim: ClaimedReminder, patch: Record<string, unknown>) {
    const { error } = await supabase
      .from("follow_up_reminder_deliveries")
      .update(patch)
      .eq("id", claim.deliveryId)
      .eq("status", "SENDING")
      .eq("attempt_count", claim.attemptCount);
    if (error) {
      console.error(JSON.stringify({ step: "reminder_delivery_update_failed", deliveryId: claim.deliveryId, message: error.message }));
    }
  }

  return {
    async claimDue(limit) {
      const { data, error } = await supabase.rpc("claim_due_follow_up_reminders", {
        p_limit: limit,
        p_max_attempts: REMINDER_MAX_ATTEMPTS,
        p_retry_backoff_minutes: REMINDER_RETRY_BACKOFF_MINUTES,
        p_stale_sending_minutes: REMINDER_STALE_SENDING_MINUTES,
      });
      if (error) throw new Error(`claim_due_follow_up_reminders failed: ${error.message}`);
      return ((data ?? []) as { delivery_id: string; follow_up_task_id: string; attempt_count: number }[]).map(
        (r) => ({ deliveryId: r.delivery_id, taskId: r.follow_up_task_id, attemptCount: r.attempt_count })
      );
    },

    async loadContexts(taskIds) {
      const contexts = new Map<string, ReminderContext>();
      if (taskIds.length === 0) return contexts;

      const { data, error } = await supabase
        .from("follow_up_tasks")
        .select(
          `id, title, notes, due_at, status, source,
           lead:leads(
             id, stage, created_at, contact:contacts(full_name, phone),
             interested_services:lead_interested_services(service_type),
             touchpoints(channel, is_primary)
           ),
           customer:customers(id, contact:contacts(full_name, phone))`
        )
        .in("id", taskIds);
      if (error) throw new Error(`reminder context query failed: ${error.message}`);
      const tasks = (data ?? []) as unknown as TaskRow[];

      const leadIds = [...new Set(tasks.map((t) => t.lead?.id).filter((id): id is string => !!id))];
      const latestByLead = new Map<string, { outcome: string; note: string | null; atIso: string }>();
      if (leadIds.length > 0) {
        const { data: convs, error: convError } = await supabase
          .from("lead_conversation_updates")
          .select("lead_id, outcome, note, created_at")
          .in("lead_id", leadIds)
          .order("created_at", { ascending: false });
        if (convError) throw new Error(`conversation query failed: ${convError.message}`);
        for (const c of (convs ?? []) as { lead_id: string; outcome: string; note: string | null; created_at: string }[]) {
          if (!latestByLead.has(c.lead_id)) {
            latestByLead.set(c.lead_id, { outcome: c.outcome, note: c.note, atIso: c.created_at });
          }
        }
      }

      for (const t of tasks) {
        contexts.set(t.id, {
          taskId: t.id,
          source: t.source,
          status: t.status,
          title: t.title,
          notes: t.notes,
          dueAtIso: t.due_at,
          lead: t.lead
            ? {
                id: t.lead.id,
                stage: t.lead.stage,
                createdAtIso: t.lead.created_at,
                fullName: t.lead.contact?.full_name ?? "איש קשר",
                phone: t.lead.contact?.phone ?? null,
                interestedServices: (t.lead.interested_services ?? []).map((s) => s.service_type),
                primaryChannel: (t.lead.touchpoints ?? []).find((tp) => tp.is_primary)?.channel ?? null,
                latestConversation: latestByLead.get(t.lead.id) ?? null,
              }
            : null,
          customer: t.customer
            ? {
                id: t.customer.id,
                fullName: t.customer.contact?.full_name ?? "איש קשר",
                phone: t.customer.contact?.phone ?? null,
              }
            : null,
        });
      }
      return contexts;
    },

    async markSent(claim, sentAtIso, providerMessageId, note) {
      await finish(claim, {
        status: "SENT",
        sent_at: sentAtIso,
        provider_message_id: providerMessageId,
        last_error: note,
      });
    },

    async markFailed(claim, error) {
      await finish(claim, { status: "FAILED", last_error: error });
    },

    async markSkipped(claim, reason) {
      await finish(claim, { status: "SKIPPED", skipped_reason: reason });
    },
  };
}
