// Server-only environment accessor for scheduled/cron endpoints.
// Mirrors lib/meta/env.ts's fail-closed style: throws a clear error
// when the secret is missing rather than letting a route silently
// accept unauthenticated requests. Never NEXT_PUBLIC_* — must never
// reach the browser.

export function getCronSecret(): string {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error(
      "Missing CRON_SECRET server environment variable. Required to " +
        "authenticate scheduled requests to /api/cron/* — without it, " +
        "those routes fail closed (401) rather than accepting any caller."
    );
  }
  return secret;
}
