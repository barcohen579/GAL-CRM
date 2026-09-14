// GAL CRM — follow-up reminder + daily digest scheduler.
//
// Triggered by Vercel Cron (see vercel.json's `crons` entries — SEVERAL
// entries pointing at this same route, spread across the day; see the
// header comment there for exactly why: this project's Vercel plan
// tier could not be confirmed from this environment, and Hobby-tier
// accounts hard-fail deployment for any cron expression firing more
// than once per day PER ENTRY — multiple once-daily entries is the
// safe way to get closer-to-real-time coverage without assuming Pro).
//
// Two independent jobs run on every invocation, both fully idempotent
// regardless of how often or how concurrently this route is called:
//
//   1. processReminders() — sends the individual "תזכורת למעקב" email
//      for any follow_up_tasks row that is due, still PENDING, and
//      has not yet had its reminder successfully delivered. See
//      lib/notifications/reminder-logic.ts for the exact eligibility
//      rules and supabase/migrations/20260904150000_..._follow_up_notifications.sql
//      for the claim-then-send-then-record architecture.
//
//   2. processDailyDigest() — sends the once-per-Israel-calendar-day
//      "המעקבים שלך להיום" summary, gated on real Asia/Jerusalem wall-
//      clock time (never the cron's own UTC firing time, which cannot
//      itself be DST-aware) via lib/crm/timezone.ts.
//
// Security: authenticated via the SAME CRON_SECRET as the other two
// cron routes (see lib/cron/auth.ts) — fails closed (401/500) exactly
// like them. Uses createAdminClient() (service_role) — the only role
// with the table grants this needs (see the migration's own grants
// section) — never reachable via a normal authenticated CRM session or
// the browser.
import { createAdminClient } from "../../../../lib/supabase/admin.ts";
import { getCronSecret } from "../../../../lib/cron/env.ts";
import { verifyCronAuthHeader } from "../../../../lib/cron/auth.ts";
import { getEmailProvider } from "../../../../lib/notifications/get-email-provider.ts";
import { getAppBaseUrl, getGalNotificationEmail } from "../../../../lib/notifications/env.ts";
import {
  buildManualFollowUpReminderEmail,
  buildAutomaticFollowUpReminderEmail,
  buildDailyDigestEmail,
} from "../../../../lib/notifications/templates.ts";
import {
  isReminderEligible,
  deliveryUpdateForSendResult,
  isAutomaticEscalationEligible,
  buildWhatsAppUrl,
} from "../../../../lib/notifications/reminder-logic.ts";
import {
  isNewLeadNotificationRetryEligible,
  sendNewLeadNotification,
} from "../../../../lib/notifications/new-lead-notification.ts";
import {
  ISRAEL_TIME_ZONE,
  zonedParts,
  zonedWallTimeToUtcIso,
  addDaysToDateKey,
  isFollowUpBusinessDay,
} from "../../../../lib/crm/timezone.ts";
import { formatDate, formatTimeOnly } from "../../../../lib/crm/format.ts";
import { SERVICE_TYPE_LABELS, type ServiceType } from "../../../../lib/crm/constants.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 60;

// Bounded, safe retry: a delivery that keeps failing stops being
// retried after this many attempts (never an infinite retry loop), and
// each retry waits at least this long since the previous attempt
// (never hammers a genuinely down provider every single cron tick).
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MINUTES = 30;

// Same bound, applied to the immediate new-lead notification's own
// retry (see processNewLeadNotificationRetries below and
// lib/notifications/new-lead-notification.ts's
// isNewLeadNotificationRetryEligible) — a separate constant, not a
// shared one, because these count a conceptually different thing
// (immediate-email attempts on one meta_lead_ingestions row, not
// follow-up-reminder attempts) even though the chosen number is the
// same. No separate backoff constant is needed here: this whole route
// only ticks once every ~2 hours (see vercel.json), which already
// spaces retries out generously on its own.
const MAX_NEW_LEAD_NOTIFICATION_ATTEMPTS = 5;

// Target morning delivery "around 08:00 Israel time" (the task's own
// wording) — real Israel wall-clock hour, DST-correct via zonedParts.
const DIGEST_HOUR_THRESHOLD = 8;

// Realistic scale for a single-studio CRM — generous headroom, not a
// hard product limit.
const MAX_REMINDER_CANDIDATES_PER_RUN = 200;

type ReminderTaskRow = {
  id: string;
  title: string;
  notes: string | null;
  due_at: string;
  status: "PENDING" | "COMPLETED" | "CANCELLED";
  source?: "MANUAL" | "AUTOMATIC" | "AI_SUGGESTED";
  lead: {
    id: string;
    stage?: string;
    contact: { full_name: string; phone: string | null } | null;
    interested_services?: { service_type: ServiceType }[];
  } | null;
  customer: { id: string; contact: { full_name: string; phone: string | null } | null } | null;
};

type ReminderDeliveryRow = {
  id: string;
  status: "PENDING" | "SENDING" | "SENT" | "FAILED";
  attempt_count: number;
  last_attempted_at: string | null;
  follow_up_task: ReminderTaskRow | null;
};

function recordPath(task: { lead: { id: string } | null; customer: { id: string } | null }): string | null {
  if (task.lead) return `/leads/${task.lead.id}`;
  if (task.customer) return `/customers/${task.customer.id}`;
  return null;
}

function contactNameOf(task: {
  lead: { contact: { full_name: string } | null } | null;
  customer: { contact: { full_name: string } | null } | null;
}): string {
  return task.lead?.contact?.full_name ?? task.customer?.contact?.full_name ?? "איש קשר";
}

// The stored phone is never itself included in an email (see
// buildWhatsAppUrl in lib/notifications/reminder-logic.ts) — this is
// only ever fed into that function to derive a wa.me URL.
function phoneOf(task: {
  lead: { contact: { phone: string | null } | null } | null;
  customer: { contact: { phone: string | null } | null } | null;
}): string | null {
  return task.lead?.contact?.phone ?? task.customer?.contact?.phone ?? null;
}

// Already-resolved Hebrew labels (SERVICE_TYPE_LABELS) — a raw enum
// value like GROUP_TRAINING never reaches the email templates. Always
// [] for a customer-linked follow-up (interested services are a Lead-
// only concept — lead_interested_services has no customer_id at all).
function interestedServiceLabelsOf(task: {
  lead: { interested_services?: { service_type: ServiceType }[] } | null;
}): string[] {
  return (task.lead?.interested_services ?? []).map(
    (s) => SERVICE_TYPE_LABELS[s.service_type]
  );
}

// Defensive cap so a pathological provider error message can never
// bloat last_error unreasonably — this column is diagnostic text, not
// a log stream.
function sanitizeErrorForStorage(message: string): string {
  return message.slice(0, 2000);
}

async function markDeliveryFailed(
  supabase: SupabaseClient,
  deliveryId: string,
  errorMessage: string
): Promise<void> {
  await supabase
    .from("follow_up_reminder_deliveries")
    .update({ status: "FAILED", last_error: sanitizeErrorForStorage(errorMessage) })
    .eq("id", deliveryId);
}

async function processReminders(supabase: SupabaseClient) {
  const now = new Date();

  // Quiet-weekend rule (§2/§11): no individual reminder email is ever
  // due on Friday/Saturday (real Israel calendar day, DST-safe via
  // isFollowUpBusinessDay). A due_at that landed on Fri/Sat simply
  // stays PENDING/un-delivered — due_at <= now stays true once real
  // Israel time crosses into Sunday, so the very next eligible-day tick
  // sends it then, with no separate "defer" bookkeeping needed. A
  // single top-of-function gate (today's day-of-week is one fact for
  // the whole run, not per-candidate) mirrors processDailyDigest's own
  // existing early-return-on-gate pattern below.
  if (!isFollowUpBusinessDay(now, ISRAEL_TIME_ZONE)) {
    return { attempted: 0, sent: 0, failed: 0, skipped: "weekend_quiet_day" };
  }

  let appBaseUrl: string;
  let recipient: string;
  try {
    appBaseUrl = getAppBaseUrl();
    recipient = getGalNotificationEmail();
  } catch (err) {
    // A configuration problem affects every candidate identically —
    // do not burn through any follow-up's retry budget over it. Just
    // report it; nothing is claimed.
    const message = err instanceof Error ? err.message : "Notification config missing";
    console.error(JSON.stringify({ step: "follow_up_reminders_config_error", message }));
    return { attempted: 0, sent: 0, failed: 0, configError: message };
  }

  const { data, error } = await supabase
    .from("follow_up_reminder_deliveries")
    .select(
      `id, status, attempt_count, last_attempted_at,
       follow_up_task:follow_up_tasks(
         id, title, notes, due_at, status, source,
         lead:leads(
           id, contact:contacts(full_name, phone),
           interested_services:lead_interested_services(service_type)
         ),
         customer:customers(id, contact:contacts(full_name, phone))
       )`
    )
    .in("status", ["PENDING", "FAILED"])
    .limit(MAX_REMINDER_CANDIDATES_PER_RUN);

  if (error) {
    console.error(
      JSON.stringify({ step: "follow_up_reminders_candidates_query_failed", message: error.message })
    );
    return { attempted: 0, sent: 0, failed: 0, error: error.message };
  }

  const provider = getEmailProvider();
  let attempted = 0;
  let sent = 0;
  let failed = 0;

  for (const row of (data ?? []) as unknown as ReminderDeliveryRow[]) {
    const task = row.follow_up_task;
    if (!task) continue; // should be impossible (FK), defensive only

    const eligible = isReminderEligible(
      {
        taskStatus: task.status,
        taskSource: task.source ?? "MANUAL",
        dueAtIso: task.due_at,
        deliveryStatus: row.status,
        attemptCount: row.attempt_count,
        lastAttemptedAtIso: row.last_attempted_at,
      },
      now,
      { maxAttempts: MAX_ATTEMPTS, backoffMinutes: RETRY_BACKOFF_MINUTES }
    );
    if (!eligible) continue;

    attempted += 1;

    // Atomic claim: only succeeds if the row is STILL in the state we
    // just observed it in — a concurrent/repeated invocation racing to
    // claim the same row gets zero rows back and moves on.
    const { data: claimed, error: claimError } = await supabase
      .from("follow_up_reminder_deliveries")
      .update({
        status: "SENDING",
        attempt_count: row.attempt_count + 1,
        last_attempted_at: now.toISOString(),
      })
      .eq("id", row.id)
      .in("status", ["PENDING", "FAILED"])
      .select("id");

    if (claimError || !claimed || claimed.length === 0) {
      continue; // lost the race (or a transient error) — next tick retries safely
    }

    try {
      const path = recordPath(task);
      if (!path) {
        await markDeliveryFailed(supabase, row.id, "Follow-up has no linked Lead or Customer");
        failed += 1;
        continue;
      }

      const email = buildManualFollowUpReminderEmail({
        leadName: contactNameOf(task),
        title: task.title,
        notes: task.notes,
        interestedServiceLabels: interestedServiceLabelsOf(task),
        dueAtIso: task.due_at,
        recordUrl: `${appBaseUrl}${path}`,
        whatsappUrl: buildWhatsAppUrl(phoneOf(task)),
      });

      const result = await provider.send({
        to: recipient,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });

      // deliveryUpdateForSendResult is the single, independently unit-
      // tested rule for "never mark SENT unless the provider actually
      // confirmed it" — see lib/notifications/reminder-logic.test.ts.
      const update = deliveryUpdateForSendResult(result, new Date());
      await supabase
        .from("follow_up_reminder_deliveries")
        .update(update)
        .eq("id", row.id)
        .eq("status", "SENDING");
      if (update.status === "SENT") sent += 1;
      else failed += 1;
    } catch (err) {
      // Never leave a row stuck in SENDING because of an unexpected
      // exception — always record a terminal FAILED result.
      const message = err instanceof Error ? err.message : "Unknown error sending reminder";
      await markDeliveryFailed(supabase, row.id, message);
      failed += 1;
    }
  }

  return { attempted, sent, failed };
}

async function processDailyDigest(supabase: SupabaseClient) {
  const now = new Date();
  const nowParts = zonedParts(now, ISRAEL_TIME_ZONE);

  // Quiet-weekend rule (§2/§8): no digest Friday, no digest Saturday —
  // checked BEFORE the hour gate so a Friday/Saturday tick never even
  // reaches "is it past 08:00 yet". Does not create a
  // daily_digest_deliveries row for that date at all (nothing to claim
  // or mark SKIPPED_EMPTY over — there was never a decision to make),
  // and Sunday's own digest still only covers Sunday's own due items
  // (see processDailyDigest's query below), never a Fri/Sat backlog.
  if (!isFollowUpBusinessDay(now, ISRAEL_TIME_ZONE)) {
    return { skipped: "weekend_quiet_day", digestDate: nowParts.dateKey };
  }

  if (nowParts.hour < DIGEST_HOUR_THRESHOLD) {
    return { skipped: "too_early", israelHour: nowParts.hour };
  }

  const { data: claimRows, error: claimError } = await supabase.rpc("claim_daily_digest_send", {
    p_digest_date: nowParts.dateKey,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (claimError) {
    console.error(JSON.stringify({ step: "daily_digest_claim_failed", message: claimError.message }));
    return { skipped: "claim_error", error: claimError.message };
  }
  const claimedId = (claimRows as { claimed_id: string }[] | null)?.[0]?.claimed_id;
  if (!claimedId) {
    return { skipped: "already_handled_or_exhausted", digestDate: nowParts.dateKey };
  }

  let appBaseUrl: string;
  let recipient: string;
  try {
    appBaseUrl = getAppBaseUrl();
    recipient = getGalNotificationEmail();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Notification config missing";
    await supabase
      .from("daily_digest_deliveries")
      .update({ status: "FAILED", last_error: sanitizeErrorForStorage(message) })
      .eq("id", claimedId);
    return { skipped: "config_error", error: message };
  }

  try {
    const dayStartIso = zonedWallTimeToUtcIso(nowParts.dateKey, "00:00", ISRAEL_TIME_ZONE);
    const dayEndIso = zonedWallTimeToUtcIso(
      addDaysToDateKey(nowParts.dateKey, 1),
      "00:00",
      ISRAEL_TIME_ZONE
    );

    const { data: todaysTasks, error: tasksError } = await supabase
      .from("follow_up_tasks")
      .select(
        `id, title, notes, due_at,
         lead:leads(id, contact:contacts(full_name)),
         customer:customers(id, contact:contacts(full_name))`
      )
      .eq("status", "PENDING")
      .gte("due_at", dayStartIso)
      .lt("due_at", dayEndIso)
      .order("due_at", { ascending: true });

    if (tasksError) throw new Error(tasksError.message);

    const tasks = (todaysTasks ?? []) as unknown as ReminderTaskRow[];

    if (tasks.length === 0) {
      // Do not send an empty digest — but DO record the decision, so
      // this Israel calendar day is never re-attempted on a later
      // cron tick the same day.
      await supabase
        .from("daily_digest_deliveries")
        .update({ status: "SKIPPED_EMPTY", follow_up_count: 0 })
        .eq("id", claimedId);
      return { skipped: "empty", digestDate: nowParts.dateKey };
    }

    const items = tasks
      .map((t) => {
        const path = recordPath(t);
        if (!path) return null;
        return {
          time: formatTimeOnly(t.due_at),
          contactName: contactNameOf(t),
          reason: t.title,
          recordUrl: `${appBaseUrl}${path}`,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const dateLabel = formatDate(dayStartIso);
    const email = buildDailyDigestEmail(items, dateLabel);

    const provider = getEmailProvider();
    const result = await provider.send({
      to: recipient,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });

    if (result.ok) {
      await supabase
        .from("daily_digest_deliveries")
        .update({
          status: "SENT",
          sent_at: new Date().toISOString(),
          provider_message_id: result.providerMessageId,
          follow_up_count: items.length,
          last_error: null,
        })
        .eq("id", claimedId);
      return { sent: true, count: items.length, digestDate: nowParts.dateKey };
    }

    await supabase
      .from("daily_digest_deliveries")
      .update({
        status: "FAILED",
        follow_up_count: items.length,
        last_error: sanitizeErrorForStorage(result.error),
      })
      .eq("id", claimedId);
    return { failed: true, error: result.error, digestDate: nowParts.dateKey };
  } catch (err) {
    // Never leave the claimed row stuck in SENDING.
    const message = err instanceof Error ? err.message : "Unknown error building/sending digest";
    await supabase
      .from("daily_digest_deliveries")
      .update({ status: "FAILED", last_error: sanitizeErrorForStorage(message) })
      .eq("id", claimedId);
    return { failed: true, error: message, digestDate: nowParts.dateKey };
  }
}

// ------------------------------------------------------------------
// Automatic new-lead follow-up escalation (Automatic Lead Follow-Up
// Escalation Loop). Unlike processReminders above (one-shot, one
// delivery row per task, EVER), this re-sends the same "still waiting"
// email once per eligible Israel calendar day, for as long as the
// lead's AUTOMATIC follow-up (created once, at lead-creation time, by
// the create_automatic_followup_for_new_lead() DB trigger) stays
// PENDING. The actual "never twice for the same lead + day" guarantee
// is lead_auto_escalation_deliveries' own UNIQUE (follow_up_task_id,
// escalation_date) constraint (INSERT ... ON CONFLICT DO NOTHING is the
// atomic claim); isAutomaticEscalationEligible is a second,
// independently-testable guard that also skips an unnecessary DB round
// trip for obviously-ineligible candidates (wrong day, WON/LOST,
// suspended by a competing manual follow-up, not due yet).
// ------------------------------------------------------------------

type EscalationTaskRow = {
  id: string;
  due_at: string;
  status: "PENDING" | "COMPLETED" | "CANCELLED";
  source: "MANUAL" | "AUTOMATIC" | "AI_SUGGESTED";
  lead: {
    id: string;
    stage: string;
    contact: { full_name: string; phone: string | null } | null;
    interested_services?: { service_type: ServiceType }[];
  } | null;
};

async function processAutomaticEscalations(supabase: SupabaseClient) {
  const now = new Date();
  const nowParts = zonedParts(now, ISRAEL_TIME_ZONE);
  const isBusinessDayToday = isFollowUpBusinessDay(now, ISRAEL_TIME_ZONE);

  // Same quiet-weekend gate as the other two jobs — checked once,
  // up front, rather than per-candidate (today's day-of-week is one
  // fact for the whole run). Still computed and passed into
  // isAutomaticEscalationEligible below too, purely so that function
  // stays the single source of truth for the full eligibility rule
  // (this early return is an optimization, not a second rule).
  if (!isBusinessDayToday) {
    return { attempted: 0, sent: 0, failed: 0, skipped: "weekend_quiet_day" };
  }

  let appBaseUrl: string;
  let recipient: string;
  try {
    appBaseUrl = getAppBaseUrl();
    recipient = getGalNotificationEmail();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Notification config missing";
    console.error(JSON.stringify({ step: "auto_escalation_config_error", message }));
    return { attempted: 0, sent: 0, failed: 0, configError: message };
  }

  const { data, error } = await supabase
    .from("follow_up_tasks")
    .select(
      `id, due_at, status, source,
       lead:leads(
         id, stage, contact:contacts(full_name, phone),
         interested_services:lead_interested_services(service_type)
       )`
    )
    .eq("status", "PENDING")
    .eq("source", "AUTOMATIC")
    .lte("due_at", now.toISOString())
    .limit(MAX_REMINDER_CANDIDATES_PER_RUN);

  if (error) {
    console.error(
      JSON.stringify({ step: "auto_escalation_candidates_query_failed", message: error.message })
    );
    return { attempted: 0, sent: 0, failed: 0, error: error.message };
  }

  const tasks = (data ?? []) as unknown as EscalationTaskRow[];
  if (tasks.length === 0) {
    return { attempted: 0, sent: 0, failed: 0 };
  }

  // A competing MANUAL (or AI_SUGGESTED) PENDING follow-up on the same
  // lead suspends automatic escalation entirely (§6) — one bulk query
  // for every candidate lead, rather than one query per row.
  const leadIds = [...new Set(tasks.map((t) => t.lead?.id).filter((id): id is string => !!id))];
  const competingLeadIds = new Set<string>();
  if (leadIds.length > 0) {
    const { data: competing, error: competingError } = await supabase
      .from("follow_up_tasks")
      .select("lead_id")
      .eq("status", "PENDING")
      .neq("source", "AUTOMATIC")
      .in("lead_id", leadIds);
    if (competingError) {
      console.error(
        JSON.stringify({ step: "auto_escalation_competing_query_failed", message: competingError.message })
      );
      // Fail safe, not fail loud: if we can't tell whether a manual
      // follow-up exists, do not risk sending a competing automatic
      // email underneath it — skip this whole run rather than guess.
      return { attempted: 0, sent: 0, failed: 0, error: competingError.message };
    }
    for (const row of (competing ?? []) as { lead_id: string }[]) {
      competingLeadIds.add(row.lead_id);
    }
  }

  const provider = getEmailProvider();
  let attempted = 0;
  let sent = 0;
  let failed = 0;

  for (const task of tasks) {
    const eligible = isAutomaticEscalationEligible(
      {
        taskStatus: task.status,
        taskSource: task.source,
        dueAtIso: task.due_at,
        leadStage: task.lead?.stage ?? "",
        hasCompetingManualFollowUp: task.lead ? competingLeadIds.has(task.lead.id) : false,
      },
      now,
      isBusinessDayToday
    );
    if (!eligible) continue;

    attempted += 1;

    // Atomic claim, first attempt of the day: INSERT ... ON CONFLICT DO
    // NOTHING against the (follow_up_task_id, escalation_date) unique
    // constraint. A concurrent/repeated invocation racing for the same
    // (task, day) simply gets zero rows back.
    const { data: inserted, error: insertError } = await supabase
      .from("lead_auto_escalation_deliveries")
      .insert({
        follow_up_task_id: task.id,
        escalation_date: nowParts.dateKey,
        status: "SENDING",
        attempt_count: 1,
        last_attempted_at: now.toISOString(),
      })
      .select("id")
      .single();

    let claimedId: string | null = null;

    if (!insertError && inserted) {
      claimedId = inserted.id;
    } else {
      // Conflict (or transient error): a row for (task, today) already
      // exists. Only a FAILED row, still within the retry budget and
      // past backoff, may be reclaimed — SENT/SENDING never are.
      const { data: existing } = await supabase
        .from("lead_auto_escalation_deliveries")
        .select("id, status, attempt_count, last_attempted_at")
        .eq("follow_up_task_id", task.id)
        .eq("escalation_date", nowParts.dateKey)
        .maybeSingle();

      if (
        existing &&
        existing.status === "FAILED" &&
        existing.attempt_count < MAX_ATTEMPTS &&
        new Date(existing.last_attempted_at).getTime() + RETRY_BACKOFF_MINUTES * 60_000 <= now.getTime()
      ) {
        const { data: reclaimed } = await supabase
          .from("lead_auto_escalation_deliveries")
          .update({ status: "SENDING", attempt_count: existing.attempt_count + 1, last_attempted_at: now.toISOString() })
          .eq("id", existing.id)
          .eq("status", "FAILED")
          .select("id")
          .single();
        if (reclaimed) claimedId = reclaimed.id;
      }
    }

    if (!claimedId) continue; // lost the race, already sent today, or not yet eligible for retry

    try {
      const path = task.lead ? `/leads/${task.lead.id}` : null;
      if (!path) {
        await supabase
          .from("lead_auto_escalation_deliveries")
          .update({ status: "FAILED", last_error: "Automatic follow-up has no linked Lead" })
          .eq("id", claimedId);
        failed += 1;
        continue;
      }

      const email = buildAutomaticFollowUpReminderEmail({
        leadName: task.lead?.contact?.full_name ?? "איש קשר",
        interestedServiceLabels: interestedServiceLabelsOf(task),
        recordUrl: `${appBaseUrl}${path}`,
        whatsappUrl: buildWhatsAppUrl(task.lead?.contact?.phone ?? null),
      });

      const result = await provider.send({
        to: recipient,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });

      const update = deliveryUpdateForSendResult(result, new Date());
      await supabase
        .from("lead_auto_escalation_deliveries")
        .update(
          update.status === "SENT"
            ? { status: "SENT", sent_at: update.sent_at, provider_message_id: update.provider_message_id, last_error: null }
            : { status: "FAILED", last_error: sanitizeErrorForStorage(update.last_error) }
        )
        .eq("id", claimedId)
        .eq("status", "SENDING");
      if (update.status === "SENT") sent += 1;
      else failed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error sending escalation reminder";
      await supabase
        .from("lead_auto_escalation_deliveries")
        .update({ status: "FAILED", last_error: sanitizeErrorForStorage(message) })
        .eq("id", claimedId);
      failed += 1;
    }
  }

  return { attempted, sent, failed };
}

// ------------------------------------------------------------------
// Immediate new-lead notification retry — the safety net for a
// TEMPORARY Resend/network failure on the synchronous first-attempt
// email (see lib/notifications/new-lead-notification.ts's
// sendNewLeadNotification, called from
// app/api/zapier/facebook-leads/route.ts and
// app/api/meta/leadgen-webhook/route.ts). Entirely separate from every
// other job in this file: it reads/writes only meta_lead_ingestions +
// a read-only lookup of the already-created contact, never touches
// follow_up_tasks/follow_up_reminder_deliveries/
// lead_auto_escalation_deliveries/daily_digest_deliveries, and leaves
// the next-day AUTOMATIC follow-up escalation entirely unaffected.
//
// Dedup/idempotency, in order of guarantee:
//   1. A resent facebookLeadId/leadgen_id never reaches this job at
//      all — it resolves to "duplicate" at ingestion time (see
//      shouldSendNewLeadNotification), so this job only ever
//      reconsiders a row already known to be genuinely PROCESSED once.
//   2. notification_sent_at is terminal — once set, this job's own
//      candidate query (`.is("notification_sent_at", null)`) and
//      isNewLeadNotificationRetryEligible both exclude the row forever.
//   3. Each individual retry ATTEMPT is claimed via a single atomic
//      compare-and-swap UPDATE keyed on the row's own
//      notification_attempt_count: `SET notification_attempt_count =
//      current + 1 WHERE id = :id AND notification_attempt_count =
//      :current AND notification_sent_at IS NULL`. Two
//      concurrent/repeated invocations racing for the same row can
//      both read the same `current`, but Postgres serializes their
//      UPDATEs — the loser's WHERE no longer matches once the winner's
//      write commits, so it gets zero rows back and moves on, exactly
//      mirroring lib/meta/repo.ts's own claimForProcessing technique
//      (a status-transition CAS there; a counter-equality CAS here,
//      since this table has no separate SENDING-style status column).
type NewLeadNotificationRetryRow = {
  id: string;
  status: string;
  contact_id: string | null;
  lead_id: string | null;
  meta_form_id: string | null;
  meta_ad_id: string | null;
  meta_campaign_id: string | null;
  received_at: string;
  raw_payload: Record<string, unknown> | null;
  notification_sent_at: string | null;
  notification_attempt_count: number;
};

export async function processNewLeadNotificationRetries(supabase: SupabaseClient) {
  let appBaseUrl: string;
  let recipient: string;
  try {
    appBaseUrl = getAppBaseUrl();
    recipient = getGalNotificationEmail();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Notification config missing";
    console.error(JSON.stringify({ step: "new_lead_notification_retry_config_error", message }));
    return { attempted: 0, sent: 0, failed: 0, configError: message };
  }

  const { data, error } = await supabase
    .from("meta_lead_ingestions")
    .select(
      "id, status, contact_id, lead_id, meta_form_id, meta_ad_id, meta_campaign_id, received_at, raw_payload, notification_sent_at, notification_attempt_count"
    )
    .eq("status", "PROCESSED")
    .is("notification_sent_at", null)
    .lt("notification_attempt_count", MAX_NEW_LEAD_NOTIFICATION_ATTEMPTS)
    .not("contact_id", "is", null)
    .not("lead_id", "is", null)
    .limit(MAX_REMINDER_CANDIDATES_PER_RUN);

  if (error) {
    console.error(
      JSON.stringify({ step: "new_lead_notification_retry_query_failed", message: error.message })
    );
    return { attempted: 0, sent: 0, failed: 0, error: error.message };
  }

  const provider = getEmailProvider();
  let attempted = 0;
  let sent = 0;
  let failed = 0;

  for (const row of (data ?? []) as unknown as NewLeadNotificationRetryRow[]) {
    const eligible = isNewLeadNotificationRetryEligible(
      {
        ingestionStatus: row.status,
        notificationSentAt: row.notification_sent_at,
        notificationAttemptCount: row.notification_attempt_count,
      },
      { maxAttempts: MAX_NEW_LEAD_NOTIFICATION_ATTEMPTS }
    );
    if (!eligible) continue;

    attempted += 1;

    // Atomic claim (see this function's own header comment for the
    // exact CAS mechanism).
    const { data: claimed, error: claimError } = await supabase
      .from("meta_lead_ingestions")
      .update({ notification_attempt_count: row.notification_attempt_count + 1 })
      .eq("id", row.id)
      .eq("notification_attempt_count", row.notification_attempt_count)
      .is("notification_sent_at", null)
      .select("id");

    if (claimError || !claimed || claimed.length === 0) {
      continue; // lost the race (or a transient error) — next tick retries safely
    }

    if (!row.contact_id || !row.lead_id) continue; // defensive, already filtered by the query above

    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("full_name, phone, email")
      .eq("id", row.contact_id)
      .maybeSingle();

    if (contactError || !contact) {
      await supabase
        .from("meta_lead_ingestions")
        .update({ notification_error: "Could not load contact for new-lead notification retry" })
        .eq("id", row.id);
      failed += 1;
      continue;
    }

    // Zapier-originated rows store resolved campaign/form/ad NAMES in
    // raw_payload (see lib/meta/zapier-ingest.ts's buildMetadata/
    // insertIngestionRow call); the direct-webhook path only ever has
    // ids (see lib/meta/webhook-payload.ts) — same distinction the
    // ORIGINAL synchronous attempt already makes in each route.
    const rawPayload = (row.raw_payload ?? {}) as Record<string, unknown>;
    const viaZapier = rawPayload.via === "zapier";
    let outcomeStatus: "SENT" | "FAILED" | null = null;

    await sendNewLeadNotification({
      provider,
      recipient,
      lead: {
        fullName: contact.full_name as string,
        phone: (contact.phone as string | null) ?? null,
        email: (contact.email as string | null) ?? null,
        source: viaZapier ? "Meta / Facebook Lead Ads (via Zapier)" : "Meta / Facebook Lead Ads",
        receivedAtIso: row.received_at,
        campaignName: viaZapier ? ((rawPayload.campaignName as string | null) ?? null) : row.meta_campaign_id,
        formName: viaZapier ? ((rawPayload.formName as string | null) ?? null) : row.meta_form_id,
        adName: viaZapier ? ((rawPayload.adName as string | null) ?? null) : row.meta_ad_id,
        recordUrl: `${appBaseUrl}/leads/${row.lead_id}`,
        whatsappUrl: buildWhatsAppUrl((contact.phone as string | null) ?? null),
      },
      recordNotification: async (result) => {
        outcomeStatus = result.status;
        await supabase
          .from("meta_lead_ingestions")
          .update(
            result.status === "SENT"
              ? { notification_sent_at: result.sentAt, notification_error: null }
              : { notification_error: result.error }
          )
          .eq("id", row.id);
      },
    });

    if (outcomeStatus === "SENT") sent += 1;
    else failed += 1;
  }

  return { attempted, sent, failed };
}

export async function GET(request: Request): Promise<Response> {
  let expectedSecret: string;
  try {
    expectedSecret = getCronSecret();
  } catch {
    return new Response("Scheduled follow-up notifications are not configured.", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (!verifyCronAuthHeader(authHeader, expectedSecret)) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const supabase = createAdminClient();

  const reminders = await processReminders(supabase);
  const escalations = await processAutomaticEscalations(supabase);
  const digest = await processDailyDigest(supabase);
  const newLeadNotificationRetries = await processNewLeadNotificationRetries(supabase);

  // Only ids/counts/dates — never a contact name, note, or email
  // address.
  console.log(
    JSON.stringify({
      step: "follow_up_notifications_cron_completed",
      reminders,
      escalations,
      digest,
      newLeadNotificationRetries,
    })
  );

  return Response.json({ ok: true, reminders, escalations, digest, newLeadNotificationRetries });
}
