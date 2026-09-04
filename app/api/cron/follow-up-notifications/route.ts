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
  buildFollowUpReminderEmail,
  buildDailyDigestEmail,
} from "../../../../lib/notifications/templates.ts";
import {
  isReminderEligible,
  deliveryUpdateForSendResult,
} from "../../../../lib/notifications/reminder-logic.ts";
import {
  ISRAEL_TIME_ZONE,
  zonedParts,
  zonedWallTimeToUtcIso,
  addDaysToDateKey,
} from "../../../../lib/crm/timezone.ts";
import { formatDate, formatTimeOnly } from "../../../../lib/crm/format.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 60;

// Bounded, safe retry: a delivery that keeps failing stops being
// retried after this many attempts (never an infinite retry loop), and
// each retry waits at least this long since the previous attempt
// (never hammers a genuinely down provider every single cron tick).
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MINUTES = 30;

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
  lead: { id: string; contact: { full_name: string } | null } | null;
  customer: { id: string; contact: { full_name: string } | null } | null;
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
         id, title, notes, due_at, status,
         lead:leads(id, contact:contacts(full_name)),
         customer:customers(id, contact:contacts(full_name))
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

      const email = buildFollowUpReminderEmail({
        contactName: contactNameOf(task),
        reason: [task.title, task.notes].filter(Boolean).join(" — "),
        dueAtIso: task.due_at,
        recordUrl: `${appBaseUrl}${path}`,
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
  const nowParts = zonedParts(new Date(), ISRAEL_TIME_ZONE);

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
  const digest = await processDailyDigest(supabase);

  // Only ids/counts/dates — never a contact name, note, or email
  // address.
  console.log(JSON.stringify({ step: "follow_up_notifications_cron_completed", reminders, digest }));

  return Response.json({ ok: true, reminders, digest });
}
