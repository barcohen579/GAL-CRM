import { timingSafeEqual } from "node:crypto";

// Verifies a cron-triggered request's Authorization header against
// CRON_SECRET. Vercel Cron Jobs automatically send
// "Authorization: Bearer <CRON_SECRET>" when that environment variable
// is configured on the project — this is what makes
// /api/cron/recurring-billing unreachable by anyone who doesn't know
// the secret, even though it's a normal public URL like any other
// Next.js route (a `crons` entry in vercel.json only controls
// SCHEDULING; it does not, by itself, restrict who else can call the
// same route over plain HTTP).
//
// Constant-time comparison (crypto.timingSafeEqual), mirroring
// lib/meta/webhook-signature.ts's own reasoning — so response timing
// never leaks how many prefix characters of the secret matched.
// Returns false — never throws — for any malformed input.
export function verifyCronAuthHeader(
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
