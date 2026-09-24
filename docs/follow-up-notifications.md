# Follow-up reminder emails (Lead Workflow V2)

GAL CRM sends Gal **exactly two kinds of routine email**. Both are
**one-shot**: at most one email per follow-up task, ever.

| Email | Subject | When it becomes eligible |
|---|---|---|
| New-lead reminder | `תזכורת לליד חדש — {name}` | 10:00 Asia/Jerusalem on the next Sun–Thu after the lead entered the CRM (manual, Meta webhook or Zapier) — only if the lead's AUTOMATIC task is still open then |
| Manual follow-up reminder | `מעקב שטרם הושלם — {name}` | 10:00 Asia/Jerusalem on the next Sun–Thu **after the follow-up's due date** — only if the follow-up is still open then |

Nothing is ever sent on an Israel Friday or Saturday. There is no
immediate "new lead" email, no daily digest and no repeating daily
escalation (all retired in V2 — their tables `daily_digest_deliveries`,
`lead_auto_escalation_deliveries` and `meta_lead_ingestions.notification_*`
are kept only as read-only history; no code reads them to send anything).

The CRM never sends WhatsApp messages. Emails include a `wa.me` button
Gal can tap when the contact has a valid phone number.

## When a reminder is cancelled

- **New-lead reminder**: its AUTOMATIC task is closed (and the reminder
  never sent) as soon as Gal creates a manual follow-up for the lead,
  moves the lead past NEW (e.g. a conversation update to "נוצר קשר"), or
  marks it WON/LOST. It is never recreated.
- **Manual reminder**: not sent if the task is completed, cancelled,
  replaced by a newer manual follow-up (one current manual follow-up per
  lead), or the lead becomes WON/LOST. After its one email, an overdue
  task stays visible in the CRM ("באיחור", sidebar badge) — no more email.

## How it works

```
follow_up_tasks INSERT ──trigger──► follow_up_reminder_deliveries (PENDING, remind_at)
                                     remind_at = follow_up_reminder_at(source, due_at)
follow_up_tasks closed ──trigger──► delivery SKIPPED (if not yet sent)

Vercel Cron ─► GET /api/cron/follow-up-notifications (Bearer CRON_SECRET)
   └─ processFollowUpReminders()            lib/notifications/reminder-job.ts
        ├─ claim_due_follow_up_reminders()  SQL: due + still-PENDING task + open lead,
        │                                    ORDER BY remind_at, LIMIT, FOR UPDATE SKIP LOCKED,
        │                                    -> SENDING, attempt_count+1; never Fri/Sat
        ├─ build email (templates.ts), send via Resend with
        │    Idempotency-Key = gal-crm-follow-up-reminder-<delivery id>
        └─ SENT / FAILED / SKIPPED (guarded by status=SENDING and attempt_count)
```

Delivery states: `PENDING` → `SENDING` → `SENT` | `FAILED` | `SKIPPED`.

- **Retry**: a `FAILED` delivery is retried after 30 minutes, up to 5
  attempts in total, then stays `FAILED` (exhausted).
- **Interrupted sends**: a row left in `SENDING` for more than 15 minutes
  (the function died mid-send) is reclaimed as a new attempt. Because every
  attempt for a delivery reuses the same Resend idempotency key (24h
  window), an email that was actually accepted before the crash is not
  delivered twice. A Resend `409 invalid_idempotent_request` is recorded as
  `SENT`. An interrupted final attempt is finalized as `FAILED`.
- **Concurrency**: `FOR UPDATE SKIP LOCKED` means concurrent cron runs
  always claim disjoint rows.

## Cron schedule and real delivery time

`vercel.json` runs the route at `0 7`, `0 8`, `0 11` and `0 14` UTC.

| UTC entry | Israel summer (IDT, UTC+3) | Israel winter (IST, UTC+2) |
|---|---|---|
| 07:00 | 10:00 — main run | 09:00 — nothing due yet |
| 08:00 | 11:00 — catch-up/retries | 10:00 — main run |
| 11:00 | 14:00 — catch-up/retries | 13:00 — catch-up/retries |
| 14:00 | 17:00 — catch-up/retries | 16:00 — catch-up/retries |

On Vercel **Hobby**, each cron entry fires at some point **within** its
hour, so the main run delivers between 10:00 and 10:59 Israel time; on
Pro it runs at the minute. A reminder is never sent before its 10:00
`remind_at`.

## Configuration

Server env vars (never `NEXT_PUBLIC_*`): `RESEND_API_KEY`, `EMAIL_FROM`,
`GAL_NOTIFICATION_EMAIL`, `APP_BASE_URL` (falls back to Vercel URLs),
`CRON_SECRET`.

## Tests

- `npm test` — includes `lib/notifications/reminder-job.test.ts`
  (one-shot, weekend, retry exhaustion, stale SENDING, concurrency,
  starvation) and `lib/crm/lead-workflow-v2.test.ts`.
- `npm run db:test:lead-workflow-v2` — SQL regression suite (rolled back).
