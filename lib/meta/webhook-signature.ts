import { createHmac, timingSafeEqual } from "node:crypto";

// Verifies Meta's X-Hub-Signature-256 header against the RAW request
// body: "sha256=<hex HMAC-SHA256 of the raw body, keyed with the app
// secret>". Payload data must never be trusted/parsed until this
// returns true — see app/api/meta/leadgen-webhook/route.ts.
//
// Uses the raw body string (not a re-serialized JSON.stringify of the
// parsed object) because Meta computes the signature over the exact
// bytes it sent — re-serializing could change whitespace/key order and
// produce a byte-for-byte different string, breaking verification for
// perfectly legitimate payloads.
//
// Comparison is constant-time (crypto.timingSafeEqual) so response
// timing never leaks how many prefix bytes of the signature matched.
// Returns false — never throws — for any malformed input (missing
// header, wrong prefix, non-hex, wrong length), so callers always get
// a clean boolean.
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const providedHex = signatureHeader.slice("sha256=".length).trim();
  if (!/^[0-9a-f]+$/i.test(providedHex)) return false;

  const expectedHex = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const providedBuf = Buffer.from(providedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (providedBuf.length !== expectedBuf.length || providedBuf.length === 0) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
