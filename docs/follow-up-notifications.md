# Follow-up notifications — architecture & manual setup

Emails Gal an individual reminder when a follow-up comes due, plus a
once-per-day morning digest of that day's pending follow-ups. Internal
reminders only — no WhatsApp/SMS, no messages sent to leads/customers
(see the task's own explicit scope boundary).

## Architecture

```
Vercel Cron (vercel.json — SEVERAL entries, see "Cron schedule" below)
  │  GET, header: Authorization: Bearer <CRON_SECRET>  (same secret as
  │  the other two cron routes)
  ▼
GET /api/cron/follow-up-notifications   app/api/cron/follow-up-notifications/route.ts
  │  verifyCronAuthHeader()              lib/cron/auth.ts
  ▼  only past this point does it touch the database or send anything
createAdminClient() (service_role)      lib/supabase/admin.ts
  │
  ├─► processReminders()   — claims + sends any due, not-yet-sent
  │                            individual reminder (see "Individual
  │                            reminders" below)
  └─► processDailyDigest() — if it's >= 08:00 Israel time and today's
                              digest hasn't been sent, sends it (see
                              "Daily digest" below)
```

Both jobs go through the same provider-independent path:

```
lib/notifications/get-email-provider.ts   -> lib/notifications/providers/resend.ts
        (the ONE place that knows which               (the ONLY file that knows
         concrete provider is active)                  Resend's specific API)
                    ▲
                    │  implements
       lib/notifications/email-provider.ts  (EmailProvider interface — .send())
```

Swapping providers later (e.g. to SES or Postmark) means writing one
new class implementing `EmailProvider` and changing the single line in
`get-email-provider.ts` — nothing else in the codebase (the cron route,
its tests, the templates) needs to know or change.

## Database changes

Migration `20260904150000_gal_crm_v1_follow_up_notifications.sql`:

- **`follow_up_reminder_deliveries`** — one row per `follow_up_tasks`
  row, auto-created in `PENDING` by a trigger the instant the task is
  created (any source, not just manual). The cron claims a due one by
  flipping `PENDING`/`FAILED` → `SENDING` via a single conditional
  `UPDATE ... WHERE status IN (...) RETURNING id` — atomic per row, so
  a concurrent/repeated cron invocation racing for the same row simply
  gets 0 rows back and moves on. Only flips to `SENT` after the email
  provider actually confirms (a real message id back); otherwise
  `FAILED`, with `attempt_count`/`last_error` for bounded, backed-off
  retry (5 attempts max, 30 minutes apart — see the route's own
  constants).
- **`daily_digest_deliveries`** — one row per Israel calendar date the
  digest was attempted for, claimed via `claim_daily_digest_send()` (an
  `INSERT ... ON CONFLICT (digest_date) DO UPDATE ... WHERE status =
  'FAILED' ... RETURNING` — the standard "create-or-conditionally-
  retry, atomically" idiom). A day with zero pending follow-ups is
  recorded as `SKIPPED_EMPTY` (a real terminal status, not silently
  left unset) so it's never re-attempted later the same day.

Neither table has any RLS policy for `authenticated` — both are pure
server-automation state, touched only by the cron's `service_role`
client. `follow_up_tasks` itself, and its create/complete/cancel Server
Actions, are completely unchanged by this migration.

## Cron schedule and its real timing precision

**This project's Vercel plan tier could not be confirmed from this
environment** (no Vercel CLI/dashboard access here — same gap already
noted in `docs/recurring-billing.md`). Per Vercel's own current docs:

| Plan | Min. interval | Precision |
|---|---|---|
| Hobby | once per day (per cron **entry**) | per-hour (±59 min) |
| Pro / Enterprise | once per minute | per-minute |

A cron expression firing more than once/day on Hobby **fails the
entire deployment**, so this could not safely default to a frequent
schedule without risking that. Instead, `vercel.json` registers **7
separate daily entries**, all pointing at the same
`/api/cron/follow-up-notifications` path, at fixed UTC hours
(04:20, 06:20, 08:20, 10:20, 12:20, 14:20, 16:20) — each entry is
individually a valid once-per-day Hobby schedule (Vercel's own docs
explicitly support multiple cron entries sharing one path), so this
works unmodified on either plan tier and needs no plan-specific
configuration.

**Real-world effect:** reminders and the digest gate-check are
evaluated roughly every 2 hours, not every minute — "at the appropriate
time" for a reminder means within about a 2-hour window of its
`due_at`, not to the exact minute, and on Hobby that window can itself
slip by up to ±59 minutes per Vercel's own imprecision guarantee. The
digest's "around 08:00 Israel time" target is met by the first tick at
or after real Israel 08:00 (gated in application code, not by the cron
schedule itself — see below), so it is never sent before 08:00 but may
land up to ~2 hours after it.

**If Pro-tier access is confirmed**, this can be tightened to near-
real-time: replace the 7 entries above with a single
`{"path": "/api/cron/follow-up-notifications", "schedule": "*/15 * * * *"}`
entry. No code changes are needed for that upgrade — the route's own
logic is frequency-agnostic by design.

## Israel timezone / DST handling

Every follow-up time is interpreted and displayed in **Asia/Jerusalem**
via `lib/crm/timezone.ts`, using real `Intl`/ICU timezone data (never
fixed +2/+3 arithmetic, which would silently break across Israel's own
DST transition dates):

- **Creating a follow-up** (`app/(app)/follow-ups/actions.ts`): the
  picked date+time is converted from "Israel wall-clock time" to the
  correct UTC instant via `zonedWallTimeToUtcIso()` — fixing a real bug
  found during this task (a naive `new Date()` parse would have
  silently stored "10:00" as 10:00 **UTC**, i.e. 12:00 or 13:00 Israel
  time depending on season).
- **Displaying times** (`lib/crm/format.ts`'s `formatDate`/
  `formatDateTime`/`formatTimeOnly`): render explicitly in
  `Asia/Jerusalem`, not the rendering server's own timezone (Vercel
  functions default to UTC).
- **"Due today" grouping** (`app/(app)/follow-ups/page.tsx`): compares
  Israel calendar days (`isSameZonedCalendarDay`), not the server's own
  local calendar day — matters specifically in the few hours around
  midnight Israel time, where the UTC day and the Israel day disagree.
- **The digest's 08:00 gate**: reads the real current Israel hour via
  `zonedParts()` — correct on both sides of a DST transition
  automatically, since it goes through the same IANA tz database, not
  a hardcoded offset.

## Email provider: Resend

No existing email provider was found anywhere in this project (checked
`package.json` and grepped the whole repo before choosing). **Resend**
(<https://resend.com>) was chosen: a minimal REST API well-suited to a
small production app's occasional transactional emails, no npm SDK
dependency needed (a single `fetch` POST with a Bearer token — see
`lib/notifications/providers/resend.ts`), reliable delivery once a
sending domain is verified.

### Exact manual setup required (I did not — and could not — do this for you)

1. **Create a Resend account** at <https://resend.com> (or sign in to
   an existing one), if you don't already have one.
2. **Add and verify a sending domain**: Resend Dashboard → Domains →
   Add Domain → enter the domain you want emails to come from (e.g.
   `yourdomain.com`, or a subdomain like `mail.yourdomain.com`).
   Resend will show you the exact DNS records to add (typically an SPF
   TXT record, a DKIM TXT record, and an MX record — the exact set
   Resend shows depends on when the domain was added). Add those
   records at your domain's DNS provider, then click "Check DNS" in
   Resend. DNS propagation can take up to 24 hours, though it's often
   faster. **If your DNS provider is Cloudflare**: the CNAME/record
   entries must be "DNS only" (grey cloud icon), not proxied (orange
   cloud) — a proxied record will never verify.
   (Resend's own current guide: <https://resend.com/docs/knowledge-base/what-if-my-domain-is-not-verifying>)
3. **Create an API key**: Resend Dashboard → API Keys → Create API
   Key. Copy it immediately (Resend only shows it once).
4. **Set the environment variables** — in the Vercel Dashboard (GAL-CRM
   project → Settings → Environment Variables, Production environment)
   AND in your local `.env.local` if you want to test locally:
   - `RESEND_API_KEY` — the key from step 3.
   - `EMAIL_FROM` — an address on the verified domain, e.g.
     `"GAL CRM <reminders@yourdomain.com>"`.
   - `GAL_NOTIFICATION_EMAIL` — the real inbox that should receive
     reminders/digests (your own address — never committed to source).
   - `APP_BASE_URL` — optional; your real production URL (e.g.
     `https://gal-crm.example.com`), so email links always point there
     rather than a Vercel-generated deployment URL. Falls back
     automatically to Vercel's own URL if left unset.
   - `CRON_SECRET` — already required by the other two cron jobs; no
     new value needed if it's already set.
5. **Redeploy** (or wait for the next deploy) so the functions pick up
   the new environment variables.
6. Until all of the above is done, the cron route fails closed for
   every candidate — it logs a config error and sends nothing (see
   `processReminders`'s/`processDailyDigest`'s own `configError`
   handling) — never a partial or silently-broken send.

No test emails were sent during this task's implementation or testing
(see "Production safety" below) — the very first real email this
system ever sends will be the first one it sends after you complete
the setup above.

## Individual reminder behavior

Fires once per follow-up, the first time a cron tick observes it as
due (`due_at <= now`), still `status = 'PENDING'` on the task itself
(a completed or cancelled follow-up is never emailed, regardless of
its delivery row's own state), and not yet successfully delivered.
Contains: the contact's name, the follow-up's own title/notes (written
by Gal herself — nothing else about the contact), the scheduled
date/time in Israel time, and a direct link to the Lead or Customer
page (protected by the existing Supabase Auth session — no new auth
mechanism, no token in the URL).

## Daily digest behavior

Sent at most once per Israel calendar day, on the first cron tick at
or after real Israel 08:00, listing every `PENDING` follow-up whose
`due_at` falls within that Israel calendar day (time + contact name +
reason, each linking to its record). A day with zero such follow-ups
sends nothing (`SKIPPED_EMPTY`) but is still recorded, so a later tick
the same day never re-checks it.

## Retry / idempotency behavior

- **Individual reminders**: up to 5 attempts, at least 30 minutes
  apart. A provider failure (network error, non-2xx response, or a
  malformed success response missing a message id) always records
  `FAILED` — never `SENT` — via a single, independently unit-tested
  rule (`deliveryUpdateForSendResult`, see
  `lib/notifications/reminder-logic.ts`). Exhausting all 5 attempts
  leaves the row permanently `FAILED` (no infinite retry loop);
  nothing surfaces this in the UI yet (out of scope — see the task's
  own "no complicated notification center yet").
- **Daily digest**: same 5-attempt/`claim_daily_digest_send` bound, keyed
  by calendar date instead of by task.
- **Concurrency**: both claim mechanisms are single atomic SQL
  statements (`UPDATE ... WHERE ... RETURNING` / `INSERT ... ON
  CONFLICT ... WHERE ... RETURNING`) — two overlapping cron
  invocations can never both "win" the same claim, so duplicate sends
  cannot happen even under genuinely concurrent or rapidly-repeated
  invocations.
