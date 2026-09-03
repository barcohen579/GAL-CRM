# Meta Lead Ads ingestion — architecture & operations

Server-side pipeline that turns a Meta Lead Ads webhook delivery into a
Contact + Lead + Touchpoint in GAL CRM. Built in Phase 3B (commit
`616635a`), hardened for production in Phase 3C.

**As of this writing, the live webhook is NOT connected in Meta** — see
[Remaining Meta Dashboard setup](#remaining-meta-dashboard-setup-manual-tomorrow)
at the bottom. Everything below describes code that is deployed-ready
but not yet receiving real traffic.

## Architecture

```
Meta                    GAL CRM (Next.js Route Handler, Node runtime)
────                    ─────────────────────────────────────────────
Page → leadgen event
  │
  ▼
POST /api/meta/leadgen-webhook
  │  X-Hub-Signature-256 header
  ▼
verifyMetaWebhookSignature()          lib/meta/webhook-signature.ts
  │  (HMAC-SHA256, constant-time compare, keyed with META_APP_SECRET)
  ▼  only past this point is the body trusted
parseLeadgenWebhookEntries()          lib/meta/webhook-payload.ts
  │  → [{ leadgenId, pageId, formId, adId, adsetId, campaignId, ... }]
  ▼  for each entry, sequentially:
processOneLeadgenId()                 lib/meta/ingest.ts
  ├─ find/insert meta_lead_ingestions row (idempotency key: leadgen_id)
  ├─ claimForProcessing() — atomic PENDING/FAILED → PROCESSING
  │  (also reclaims a row stuck in PROCESSING >10 min — see below)
  ├─ makePageAccessTokenDeriver()      lib/meta/graph.ts (GET /me/accounts)
  ├─ fetchLeadByLeadgenId()            lib/meta/graph.ts (GET /{leadgen_id})
  ├─ extractLeadFields()               lib/meta/field-data.ts
  ├─ matchAndCreateCrmEntities()       lib/meta/ingest.ts
  │    ├─ contact: normalized phone → normalized email → else create
  │    ├─ lead: reuse OPEN lead, else create NEW
  │    └─ touchpoint: exactly one per leadgen_id (channel=META_AD)
  └─ mark the ingestion row PROCESSED / DUPLICATE_IGNORED / FAILED
```

All Supabase access in this pipeline uses the **service_role** key
(`lib/supabase/admin.ts`) — never the anon key, never reachable from
the browser. All Meta API calls (`lib/meta/graph.ts`) are **read-only
GET requests** — this pipeline never writes to Meta.

## Required environment variables

Server-only (never `NEXT_PUBLIC_*`) — see `.env.example` for the
documented, value-free template:

| Variable | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | every Supabase client (public, not a secret) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the app's normal authenticated CRM access |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/supabase/admin.ts` — ingestion writes |
| `META_ACCESS_TOKEN` | `lib/meta/graph.ts` — derive Page token, fetch lead |
| `META_AD_ACCOUNT_IDS` | `scripts/meta-sync.mjs` (unrelated spend sync, not this pipeline) |
| `META_APP_SECRET` | webhook POST signature verification |
| `META_WEBHOOK_VERIFY_TOKEN` | webhook GET verification handshake |

Every accessor (`lib/meta/env.ts`, `lib/supabase/admin.ts`) fails
closed with a specific error naming the missing variable — nothing
silently runs half-configured. Hit `GET /api/meta/leadgen-webhook/health`
after deploying to confirm all six are present (booleans only, no
values — see [Health endpoint](#health-endpoint)).

## Target Meta Page

Page ID `166795883755512` ("גל ולדמן מאמנת כושר אישית"), verified
reachable via the System User token during Phase 3A/3B readiness
checks. Known active lead forms at that time:
`1685373440263389` and `2148943306018027`.

## Webhook route — `app/api/meta/leadgen-webhook/route.ts`

- **GET**: answers Meta's verification handshake
  (`hub.mode`/`hub.verify_token`/`hub.challenge`) against
  `META_WEBHOOK_VERIFY_TOKEN`. Echoes the challenge only on an exact
  match; 403 otherwise; 500 (config missing) if the token isn't set.
- **POST**: reads the raw body, verifies `X-Hub-Signature-256` against
  `META_APP_SECRET` **before parsing anything**, then processes each
  leadgen entry **synchronously**, in order, within the same request.
  Returns HTTP 500 if any entry's processing genuinely failed (so
  Meta's own webhook delivery retries with its own backoff) or 200
  otherwise (including for legitimate duplicates).
- Uses the plain Web `Response` API (not `NextResponse`) so both
  handlers can be imported and called directly in tests with a real
  `Request`, with no server and no bundler involved
  (`route.test.ts`).

### Why synchronous, no queue

Documented in full at the top of `lib/meta/ingest.ts`. Summary: this
integration's real volume (one Page, a personal-training business) and
per-lead work (at most two Meta GETs + a handful of small Supabase
calls, normally sub-second) fit comfortably inside a single request. A
queue/worker would add real operational complexity for no benefit at
this scale. If that ever changes, only the caller (the route handler)
needs to change — `processOneLeadgenId` already returns a clean
success/duplicate/failure outcome per leadgen_id regardless of who
calls it synchronously or from a worker.

## Idempotency strategy (defense in depth, three independent layers)

1. **`meta_lead_ingestions.leadgen_id` is `UNIQUE`** — a concurrent
   duplicate `INSERT` for the same leadgen_id fails with Postgres
   `23505`; the code catches this and re-reads the existing row instead
   of erroring (`lib/meta/repo.ts::insertIngestionRow`).
2. **Atomic claim**: `claimForProcessing` is a single
   `UPDATE ... WHERE status IN ('PENDING','FAILED') OR (status='PROCESSING' AND updated_at < now() - 10min) RETURNING *`.
   Two concurrent callers can both match the `WHERE`, but Postgres
   serializes the two `UPDATE`s against the row lock — only the first
   actually transitions the row; the second's `WHERE` no longer matches
   once re-evaluated, so it claims nothing (`outcome: "in_progress_elsewhere"`).
   Verified with real concurrent async calls in
   `lib/meta/concurrency.test.ts` (`Promise.all` of 8 simultaneous
   deliveries for the same leadgen_id → exactly one Contact/Lead/Touchpoint).
3. **DB-level touchpoint uniqueness**:
   `touchpoints_meta_ad_external_ref_key` — a partial unique index on
   `touchpoints(external_ref) WHERE channel='META_AD' AND external_ref IS NOT NULL`
   (migration `20260903012229_..._meta_touchpoint_uniqueness.sql`).
   Makes "two META_AD touchpoints for the same leadgen_id" impossible
   at the database level, independent of any application-code race —
   not just the pre-insert check in `matchAndCreateCrmEntities`. Other
   channels' touchpoints (including existing manually-created ones with
   `external_ref = NULL`) are completely unaffected — NULLs are never
   considered equal by a unique index.

### Stale PROCESSING recovery

A row claimed but never finished (process crashed/was killed) would,
without recovery, block that leadgen_id forever — nothing else would
ever touch it again. `claimForProcessing`'s `OR` clause above also
reclaims a row that has been in `PROCESSING` for **more than 10
minutes** (`STALE_PROCESSING_MS` in `lib/meta/repo.ts`), which is
generously long for this pipeline's real (sub-second) work. Recovery
happens automatically the next time *anything* touches that leadgen_id
again — a Meta redelivery, or a manual
`npm run meta:reprocess-lead -- <leadgen_id>` run.

## Contact matching (`lib/meta/ingest.ts` → `matchAndCreateCrmEntities`)

1. Normalized phone (`lib/meta/normalize.ts::normalizePhone`) — strips
   non-digits, applies an Israel-specific "leading 0 → 972" rule so
   `050-123-4567`, `+972 50 123 4567`, and `972501234567` all compare
   equal. Never forces a country code onto a number that doesn't look
   Israeli. **Known, accepted limitation**: a non-Israeli local-format
   number that happens to be 9–10 digits with a leading 0 would be
   mis-normalized as Israeli — acceptable given this CRM serves an
   Israeli business exclusively; fixing it would require guessing a
   country, which is worse.
2. Normalized email (`normalizeEmail`) — trim + lowercase only, no
   provider-specific rewriting (no Gmail dot/plus stripping — that
   would risk merging two different real inboxes on a guess).
3. **Never** matched by name, fuzzy or otherwise.

If a match is found, only **missing** (`null`) phone/email fields are
filled in — existing contact data is never overwritten
(`fillMissingContactFields`).

**Known, accepted concurrency limitation**: two genuinely-simultaneous
*first-ever* submissions by the same brand-new person, via two
*different* leadgen_ids (e.g. two different ad forms within
milliseconds of each other), can create two separate Contacts — there
is no DB-level uniqueness on phone/email (unlike leadgen_id/touchpoint
above), because contact matching is intentionally application-level
(see the Phase 3B/3C reports for why: keeps matching testable without a
live database, and a normalized-column approach would need retroactive
backfill of existing manually-entered contacts). Pinned by a test in
`lib/meta/concurrency.test.ts`. Real-world likelihood is very low; not
fixed tonight as it would require either an advisory lock spanning
multiple Supabase calls or a schema change reaching into `contacts`,
neither justified by the actual risk at this business's scale.

## Lead reuse rules

- An existing **OPEN** lead for the contact (`stage NOT IN ('WON','LOST')`)
  is reused as-is — its stage is **never** reset, never touched.
- A new lead (`stage = 'NEW'`, the column default) is created only when
  the contact has no lead yet, or every existing lead is closed.

## Touchpoint rules

- Exactly one per `leadgen_id`, enforced at the DB level (see above).
- `channel = 'META_AD'`, `certainty = 'CONFIRMED'`.
- `external_ref = leadgen_id`.
- `metadata` (jsonb; added in the Phase 3C migration alongside the
  unique index) carries `{ pageId, formId, adId, adsetId, campaignId }`
  — whichever of those Meta actually supplied.
- `is_primary = true` only when it is the very first touchpoint on that
  lead (never overrides existing attribution on a reused lead).

## Retry / reprocess

```
npm run meta:reprocess-lead -- <leadgen_id>
```

Trusted, server-only CLI (`scripts/meta-reprocess-lead.ts`) sharing
`processOneLeadgenId` with the webhook route — "reprocess" and
"process for the first time" are the exact same code path, so there is
nothing separate to keep in sync. Idempotent: safe to run against an
already-`PROCESSED`/`DUPLICATE_IGNORED` row (no-ops), and safe to
re-run after a `FAILED` attempt.

## Local/offline testing without any real Meta call or real Supabase project

```
npm test                                # 60+ automated tests, incl. the full mock flow
npx supabase db query --linked "..."    # ad-hoc read-only DB verification
node scripts/meta-webhook-mock-demo.ts  # human-readable walkthrough, fully offline
```

`lib/meta/mock-webhook.ts` builds a synthetic, correctly-HMAC-signed
webhook body from fake data. `lib/meta/webhook-flow.test.ts` drives it
through the real signature-verification/parsing/ingestion code against
an in-memory fake repo + fake Meta fetch (`lib/meta/fakes.ts`) — the
exact same assertions the demo script prints, but run automatically.
Neither ever touches the live Supabase project or the real Meta API.

## Health endpoint

`GET /api/meta/leadgen-webhook/health` — reports only booleans (each
required variable present/absent), `200` if all six are set, `503`
otherwise. No secret value, no database query, no Meta call — safe to
leave publicly reachable. Use this right after deploying to confirm
production config before connecting the live webhook.

## Deployment prerequisites

1. A public HTTPS URL serving this Next.js app (no hosting provider is
   currently configured in this repository — see the Phase 3C report
   for exactly what was checked).
2. All six env vars above set in that hosting provider's environment
   (never commit real values — `.env.example` documents names only).
3. `GET https://<your-domain>/api/meta/leadgen-webhook/health` returns
   `{"ready": true, ...}`.
4. Apply any pending Supabase migrations to the linked project
   (`npx supabase db push`) before connecting the live webhook.

## Remaining Meta Dashboard setup (manual, tomorrow)

**Not done tonight, deliberately** — see the Phase 3C report for the
full rationale:

1. Deploy the app to a public HTTPS host (pick a provider, none is
   configured yet).
2. Set the six env vars in that host's dashboard.
3. Confirm `/api/meta/leadgen-webhook/health` returns `ready: true`.
4. In the Meta Developer Dashboard, add the webhook callback URL
   (`https://<domain>/api/meta/leadgen-webhook`) and the same value you
   put in `META_WEBHOOK_VERIFY_TOKEN`.
5. Subscribe the app to the `leadgen` field.
6. Subscribe Page `166795883755512` to that app.
7. Send a real test lead (or use Meta's own "Test Lead" tool in Ads
   Manager) and confirm a row appears in `meta_lead_ingestions` with
   `status = 'PROCESSED'`.
