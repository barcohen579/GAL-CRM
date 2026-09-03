// Server-only environment accessors for the Meta Lead Ads integration.
// Mirrors lib/supabase/env.ts's fail-closed style: every accessor
// throws a clear, specific error when its variable is missing rather
// than letting a later call fail confusingly deep inside crypto/fetch
// code. NEVER read, log, or return these anywhere but here — no caller
// in this codebase should print an actual token/secret value.
//
// These are never NEXT_PUBLIC_* — none of them may ever reach the
// browser.

export function getMetaAccessToken(): string {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "Missing META_ACCESS_TOKEN server environment variable. Required to " +
        "derive a Page Access Token and fetch lead details from the Graph API."
    );
  }
  return token;
}

export function getMetaAppSecret(): string {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    throw new Error(
      "Missing META_APP_SECRET server environment variable. Required to " +
        "verify the X-Hub-Signature-256 header on incoming webhook POSTs — " +
        "without it, webhook payloads cannot be trusted and must be rejected."
    );
  }
  return secret;
}

export function getMetaWebhookVerifyToken(): string {
  const token = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!token) {
    throw new Error(
      "Missing META_WEBHOOK_VERIFY_TOKEN server environment variable. " +
        "Required to answer Meta's webhook verification GET request " +
        "(hub.verify_token check)."
    );
  }
  return token;
}
