# Zapier -> Facebook Lead Ads ingestion (via Webhooks by Zapier)

A second entry point into the same Meta Lead Ads ingestion pipeline
documented in `docs/meta-lead-ingestion.md`, for the case where Zapier
sits between Facebook Lead Ads and GAL CRM instead of Meta calling this
app's webhook directly.

Zap shape:

```
Trigger: Facebook Lead Ads -> New Lead (Page: גל, Form: the campaign's lead form)
  │  Zapier itself calls the Graph API and resolves the full lead
  │  (name/phone/email/ad/adset/campaign/form) — no separate fetch
  │  needed on our side.
  ▼
Action: Webhooks by Zapier -> POST
  │  Authorization: Bearer <ZAPIER_LEAD_WEBHOOK_SECRET>
  ▼
POST https://<your-domain>/api/zapier/facebook-leads
  │  verifyZapierAuthHeader()              lib/meta/zapier-auth.ts
  ▼  only past this point is the body trusted
  parseZapierLeadPayload()                 lib/meta/zapier-payload.ts
  ▼
  processZapierLead()                      lib/meta/zapier-ingest.ts
  ├─ find/insert meta_lead_ingestions row (idempotency key: facebookLeadId,
  │  stored in the same leadgen_id column the direct Meta webhook uses)
  ├─ claimForProcessing() — same atomic PENDING/FAILED -> PROCESSING guard
  ├─ matchAndCreateCrmEntities()           lib/meta/ingest.ts (SHARED —
  │    the exact same function the direct Meta webhook uses)
  │    ├─ contact: normalized phone -> normalized email -> else create
  │    ├─ lead: reuse OPEN lead, else create NEW
  │    └─ touchpoint: exactly one per facebookLeadId (channel=META_AD)
  └─ mark the ingestion row PROCESSED / DUPLICATE_IGNORED / FAILED
```

## Why this is not a second/duplicate pipeline

Everything below the auth+payload layer is the **same code** as the
direct Meta webhook (`app/api/meta/leadgen-webhook`):

- Same `meta_lead_ingestions` table, same `leadgen_id` idempotency key
  (a Zapier-relayed lead's `facebookLeadId` **is** the real Facebook
  `leadgen_id` — Zapier doesn't invent a new one).
- Same `matchAndCreateCrmEntities` (phone-then-email contact matching,
  never fuzzy name matching, OPEN-lead reuse, exactly-one-touchpoint-
  per-lead).
- Same `touchpoints` channel (`META_AD`) — no new enum value, no
  parallel "lead source" model. `TOUCHPOINT_CHANNELS` in
  `lib/crm/constants.ts` already has `META_AD`; a Zapier-relayed
  Facebook Lead Ads lead is a Meta ad lead, full stop.
- Same DB-level uniqueness
  (`touchpoints_meta_ad_external_ref_key`, partial unique index on
  `touchpoints(external_ref) WHERE channel='META_AD'`) — so even if the
  direct Meta webhook is connected later, the SAME real Facebook lead
  arriving via both routes still only ever produces one Contact/Lead/
  Touchpoint set.

What genuinely differs (and is why this isn't just reusing the Meta
webhook route as-is):

1. **Auth**: Zapier cannot compute Meta's `X-Hub-Signature-256` HMAC
   (it doesn't have `META_APP_SECRET`) — this endpoint instead checks a
   shared bearer secret, `ZAPIER_LEAD_WEBHOOK_SECRET`
   (`lib/meta/zapier-auth.ts`).
2. **No Graph API call**: Zapier's own Facebook Lead Ads trigger has
   already resolved the full lead. The direct Meta webhook receives
   only ids and must call the Graph API itself
   (`lib/meta/graph.ts`); this path receives `fullName`/`phone`/
   `email`/etc. directly in the POST body and skips straight to
   `matchAndCreateCrmEntities` (`lib/meta/zapier-ingest.ts`).
3. **Provenance in the timeline**: the touchpoint's `source_detail`
   reads "ליד מפרסומת Meta (Lead Ads) — התקבל דרך Zapier" (vs. the
   direct webhook's plain "ליד מפרסומת Meta (Lead Ads)"), and its
   `metadata` jsonb includes `via: "zapier"` plus whichever of
   `campaignName`/`formName`/`adName`/`adsetName` Zapier supplied (the
   direct webhook only has ids, not names, since the Graph API lead
   node doesn't return them) — same jsonb column, no schema change.

## Required environment variable

| Variable | Used by |
|---|---|
| `ZAPIER_LEAD_WEBHOOK_SECRET` | `lib/meta/zapier-auth.ts` — POST auth |

All the other env vars this pipeline needs
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) are already required by the rest of the
app / the direct Meta webhook — see `docs/meta-lead-ingestion.md`.
`META_ACCESS_TOKEN`/`META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN` are
**not** needed by this route at all (no Graph API call, no HMAC).

Check `GET /api/zapier/facebook-leads/health` after deploying — reports
only booleans, no values, safe to leave publicly reachable.

## Endpoint

`POST /api/zapier/facebook-leads`

- **Auth**: `Authorization: Bearer <ZAPIER_LEAD_WEBHOOK_SECRET>`.
  Missing/wrong -> `401`. Secret not configured server-side -> `500`
  (fails closed, never accepts an unauthenticated caller).
- **Body**: a single flat JSON object (not an array — see "Wrap Request
  In Array" below).

  | Key | Required | Notes |
  |---|---|---|
  | `facebookLeadId` | yes | Idempotency key — Facebook's Lead ID. |
  | `fullName` | yes | |
  | `phone` | yes | Normalized with the same Israeli-number logic as the direct webhook (`lib/meta/normalize.ts`) before contact matching. |
  | `email` | no | |
  | `source` | no | Free text, stored in touchpoint metadata (`zapierSource`) for audit; does not create/require any new CRM enum. |
  | `campaignName` | no | |
  | `formName` | no | |
  | `adId` / `adName` | no | |
  | `adsetId` / `adsetName` | no | |
  | `campaignId` | no | |
  | `pageId` / `formId` | no | Optional bonus ids, not required. |
  | `occurredAt` | no | ISO datetime; falls back to server receive time if absent/unparseable. |

  Missing `facebookLeadId`/`fullName`/`phone`, or a non-object/array
  body, -> `400` with `{ success: false, error, details: [...] }`
  listing every problem at once.

- **Response on success**:
  - New lead: `201 { success: true, outcome: "processed", leadId, contactId, touchpointId }`
  - Already seen this `facebookLeadId` before: `200 { success: true, outcome: "duplicate", leadId, contactId, touchpointId }`
    (a genuine success from Zapier's point of view — never retried).
- **Response on failure**: `500 { success: false, error }` — safely
  retryable (dedup is by `facebookLeadId`, so a Zapier retry or a
  manual re-send never creates a second lead).
- Never logs `fullName`/`phone`/`email` — only ids and outcome labels
  (`console.log({ step: "zapier_facebook_lead_processed", facebookLeadId, outcome })`),
  mirroring the direct webhook's own logging convention.

## Exact Zapier "Webhooks by Zapier" POST action configuration

See the chat response for the field-by-field mapping to enter in
Zapier's UI (URL, Payload Type, Data keys, Headers, Wrap Request In
Array, Unflatten, Basic Auth, safe Test). Not duplicated here to avoid
two copies drifting — this doc covers the server side; the assistant's
final message in the setup conversation is the operational checklist.

## Local/offline testing

```
npm test    # lib/meta/zapier-auth.test.ts, zapier-payload.test.ts,
            # zapier-ingest.test.ts (full mock flow via the same
            # in-memory fakes.ts as the direct webhook's own tests),
            # and app/api/zapier/facebook-leads/route.test.ts (auth +
            # validation at the HTTP layer)
```

No live Supabase project or real Zapier delivery is touched by any of
the above.
