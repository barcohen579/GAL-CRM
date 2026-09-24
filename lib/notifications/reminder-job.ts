// Lead Workflow V2 reminder job: claims due reminder deliveries, sends
// the ONE email each deserves, records the result. The DB access is
// injected (ReminderRepo) so the whole orchestration — including
// concurrent runs, retry exhaustion and stale-SENDING recovery — is
// unit-testable with an in-memory fake (reminder-job.test.ts). The
// Supabase implementation is lib/notifications/reminder-repo.ts; the
// authoritative claim semantics are SQL claim_due_follow_up_reminders().

import type { EmailProvider } from "./email-provider.ts";
import {
  buildManualFollowUpReminderEmail,
  buildNewLeadReminderEmail,
  type LatestConversation,
} from "./templates.ts";
import {
  buildWhatsAppUrl,
  deliveryOutcomeForSendResult,
  reminderIdempotencyKey,
  reminderKindForSource,
  reminderSkipReason,
  type FollowUpTaskSource,
  type FollowUpTaskStatus,
} from "./reminder-logic.ts";
import { isFollowUpBusinessDay } from "../crm/timezone.ts";
import {
  LEAD_CONVERSATION_OUTCOME_LABELS,
  LEAD_STAGE_LABELS,
  SERVICE_TYPE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
  isLeadConversationOutcome,
  type LeadStage,
  type ServiceType,
  type TouchpointChannel,
} from "../crm/constants.ts";

export type ClaimedReminder = { deliveryId: string; taskId: string; attemptCount: number };

export type ReminderContext = {
  taskId: string;
  source: FollowUpTaskSource;
  status: FollowUpTaskStatus;
  title: string;
  notes: string | null;
  dueAtIso: string;
  lead: {
    id: string;
    stage: LeadStage;
    createdAtIso: string;
    fullName: string;
    phone: string | null;
    interestedServices: ServiceType[];
    primaryChannel: TouchpointChannel | null;
    latestConversation: { outcome: string; note: string | null; atIso: string } | null;
  } | null;
  customer: { id: string; fullName: string; phone: string | null } | null;
};

export interface ReminderRepo {
  /** Atomically claims up to `limit` due deliveries (SQL
   *  claim_due_follow_up_reminders: ordered, SKIP LOCKED, bounded retry,
   *  stale-SENDING recovery). */
  claimDue(limit: number): Promise<ClaimedReminder[]>;
  loadContexts(taskIds: string[]): Promise<Map<string, ReminderContext>>;
  /** Each mark* only applies while the row is still SENDING with the
   *  same attempt_count this run claimed — a slower, superseded worker can
   *  never overwrite a newer attempt's result. */
  markSent(claim: ClaimedReminder, sentAtIso: string, providerMessageId: string | null, note: string | null): Promise<void>;
  markFailed(claim: ClaimedReminder, error: string): Promise<void>;
  markSkipped(claim: ClaimedReminder, reason: string): Promise<void>;
}

export type ReminderJobResult = {
  skipped?: "weekend_quiet_day";
  claimed: number;
  sent: number;
  failed: number;
  skippedRows: number;
};

export type ReminderJobParams = {
  repo: ReminderRepo;
  provider: EmailProvider;
  recipient: string;
  appBaseUrl: string;
  now?: () => Date;
  batchSize?: number;
  /** Stop claiming new batches after this many ms (Vercel function
   *  limit headroom). Anything claimed but not finished is recovered by
   *  the stale-SENDING rule on a later run. */
  timeBudgetMs?: number;
};

function sanitizeError(message: string): string {
  return message.slice(0, 2000);
}

function latestConversationFor(ctx: ReminderContext): LatestConversation | null {
  const latest = ctx.lead?.latestConversation;
  if (!latest) return null;
  return {
    outcomeLabel: isLeadConversationOutcome(latest.outcome)
      ? LEAD_CONVERSATION_OUTCOME_LABELS[latest.outcome]
      : latest.outcome,
    note: latest.note,
    atIso: latest.atIso,
  };
}

export function buildReminderEmail(ctx: ReminderContext, appBaseUrl: string) {
  const kind = reminderKindForSource(ctx.source);
  const services = (ctx.lead?.interestedServices ?? []).map((s) => SERVICE_TYPE_LABELS[s] ?? s);

  if (kind === "NEW_LEAD" && ctx.lead) {
    return buildNewLeadReminderEmail({
      leadName: ctx.lead.fullName,
      phone: ctx.lead.phone,
      stageLabel: LEAD_STAGE_LABELS[ctx.lead.stage] ?? ctx.lead.stage,
      interestedServiceLabels: services,
      sourceLabel: ctx.lead.primaryChannel ? TOUCHPOINT_CHANNEL_LABELS[ctx.lead.primaryChannel] : null,
      leadCreatedAtIso: ctx.lead.createdAtIso,
      latestConversation: latestConversationFor(ctx),
      recordUrl: `${appBaseUrl}/leads/${ctx.lead.id}`,
      whatsappUrl: buildWhatsAppUrl(ctx.lead.phone),
    });
  }

  const person = ctx.lead ?? ctx.customer;
  const phone = person?.phone ?? null;
  return buildManualFollowUpReminderEmail({
    name: person?.fullName ?? "איש קשר",
    phone,
    stageLabel: ctx.lead ? (LEAD_STAGE_LABELS[ctx.lead.stage] ?? ctx.lead.stage) : null,
    isCustomer: !ctx.lead,
    interestedServiceLabels: services,
    title: ctx.title,
    notes: ctx.notes,
    dueAtIso: ctx.dueAtIso,
    latestConversation: latestConversationFor(ctx),
    recordUrl: ctx.lead ? `${appBaseUrl}/leads/${ctx.lead.id}` : `${appBaseUrl}/customers/${ctx.customer?.id}`,
    whatsappUrl: buildWhatsAppUrl(phone),
  });
}

export async function processFollowUpReminders(params: ReminderJobParams): Promise<ReminderJobResult> {
  const { repo, provider, recipient, appBaseUrl } = params;
  const now = params.now ?? (() => new Date());
  const batchSize = params.batchSize ?? 5;
  const timeBudgetMs = params.timeBudgetMs ?? 25_000;
  const startedAt = now().getTime();

  const result: ReminderJobResult = { claimed: 0, sent: 0, failed: 0, skippedRows: 0 };

  // Quiet weekend: nothing is ever sent on an Israel Friday/Saturday
  // (the SQL claim enforces the same rule independently).
  if (!isFollowUpBusinessDay(now())) {
    return { ...result, skipped: "weekend_quiet_day" };
  }

  while (now().getTime() - startedAt < timeBudgetMs) {
    const claims = await repo.claimDue(batchSize);
    if (claims.length === 0) break;
    result.claimed += claims.length;

    const contexts = await repo.loadContexts(claims.map((c) => c.taskId));

    for (const claim of claims) {
      const ctx = contexts.get(claim.taskId) ?? null;
      const skipReason = reminderSkipReason({
        taskStatus: ctx?.status ?? null,
        leadStage: ctx?.lead?.stage ?? null,
        hasParent: !!(ctx?.lead || ctx?.customer),
      });
      if (!ctx || skipReason) {
        await repo.markSkipped(claim, skipReason ?? "task not found");
        result.skippedRows += 1;
        continue;
      }

      try {
        const email = buildReminderEmail(ctx, appBaseUrl);
        const sendResult = await provider.send({
          to: recipient,
          subject: email.subject,
          html: email.html,
          text: email.text,
          idempotencyKey: reminderIdempotencyKey(claim.deliveryId),
        });
        const outcome = deliveryOutcomeForSendResult(sendResult, now());
        if (outcome.status === "SENT") {
          await repo.markSent(claim, outcome.sentAtIso, outcome.providerMessageId, outcome.note);
          result.sent += 1;
        } else {
          await repo.markFailed(claim, sanitizeError(outcome.error));
          result.failed += 1;
        }
      } catch (err) {
        // Never leave the row in SENDING because of an unexpected error.
        const message = err instanceof Error ? err.message : "Unknown error sending reminder";
        await repo.markFailed(claim, sanitizeError(message));
        result.failed += 1;
      }
    }
  }

  return result;
}
