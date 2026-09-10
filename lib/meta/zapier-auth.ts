import { timingSafeEqual } from "node:crypto";

// Verifies a Zapier-originated request's Authorization header against
// ZAPIER_LEAD_WEBHOOK_SECRET. Zapier's "Webhooks by Zapier" POST action
// sends whatever static header value you type into its Headers section
// (see docs/zapier-facebook-leads.md) — there is no Meta-style HMAC
// signature available here, so a shared bearer secret is the whole
// authentication mechanism for this endpoint.
//
// Constant-time comparison (crypto.timingSafeEqual), mirroring
// lib/cron/auth.ts and lib/meta/webhook-signature.ts's own reasoning —
// so response timing never leaks how many prefix characters of the
// secret matched. Returns false — never throws — for any malformed
// input (missing header, wrong scheme, wrong length).
export function verifyZapierAuthHeader(
  authHeader: string | null | undefined,
  expectedSecret: string
): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;

  const provided = authHeader.slice("Bearer ".length);
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expectedSecret, "utf8");
  if (providedBuf.length !== expectedBuf.length || providedBuf.length === 0) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
