// Builds a realistic, entirely-synthetic Meta Lead Ads webhook
// delivery — body + a correctly computed X-Hub-Signature-256 — for
// local/integration testing without ever touching the real Meta API or
// the live Supabase project. Used by:
//   - lib/meta/webhook-flow.test.ts (automated, runs in `npm test`)
//   - scripts/meta-webhook-mock-demo.ts (manual, human-readable walkthrough)
//
// IMPORTANT: every value here is fake/synthetic by construction (no
// real names/phones/emails ever pass through this file). Never wire
// this into a path that touches the real Supabase project or real Meta
// credentials.

import { createHmac } from "node:crypto";
import type { MetaFieldDatum } from "./graph.ts";

export type MockLeadgenChange = {
  leadgenId: string;
  pageId?: string;
  formId?: string;
  adId?: string;
  adsetId?: string;
  campaignId?: string;
  createdTimeUnixSeconds?: number;
};

export function buildMockWebhookBody(changes: MockLeadgenChange[]): unknown {
  return {
    object: "page",
    entry: changes.map((c) => ({
      id: c.pageId ?? "000000000000001",
      time: c.createdTimeUnixSeconds ?? Math.floor(Date.now() / 1000),
      changes: [
        {
          field: "leadgen",
          value: {
            leadgen_id: c.leadgenId,
            page_id: c.pageId ?? "000000000000001",
            form_id: c.formId ?? "000000000000002",
            adgroup_id: c.adsetId ?? "000000000000003",
            ad_id: c.adId ?? "000000000000004",
            campaign_id: c.campaignId ?? "000000000000005",
            created_time: c.createdTimeUnixSeconds ?? Math.floor(Date.now() / 1000),
          },
        },
      ],
    })),
  };
}

export type SignedMockWebhook = {
  rawBody: string;
  signatureHeader: string;
};

// Signs with the exact same algorithm Meta uses (and
// lib/meta/webhook-signature.ts verifies): HMAC-SHA256 over the raw
// body bytes, keyed with the app secret, hex-encoded, prefixed
// "sha256=".
export function signMockWebhookBody(body: unknown, appSecret: string): SignedMockWebhook {
  const rawBody = JSON.stringify(body);
  const signatureHeader =
    "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return { rawBody, signatureHeader };
}

// A synthetic Meta lead-detail response (what GET /{leadgen_id} would
// return) — the fake fetchLead in a mock run returns this shape.
// full_name/phone/email here are OBVIOUSLY fake demo values, never
// real customer data.
export function buildMockLeadFieldData(overrides?: {
  fullName?: string;
  phone?: string;
  email?: string;
}): MetaFieldDatum[] {
  return [
    { name: "full_name", values: [overrides?.fullName ?? "Demo Test Lead"] },
    { name: "phone_number", values: [overrides?.phone ?? "0500000000"] },
    { name: "email", values: [overrides?.email ?? "demo-test-lead@example.invalid"] },
  ];
}
