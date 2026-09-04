// Server-only environment accessors for the notification/email system.
// Mirrors lib/meta/env.ts's fail-closed style: every accessor throws a
// clear, specific error when its variable is missing rather than
// letting a later call fail confusingly deep inside fetch code, or
// (worse) silently sending to nobody / from an unverified address.
// NEVER log, print, or return these anywhere but here.
//
// None of these are ever NEXT_PUBLIC_* — none may ever reach the
// browser. See .env.example for the full documented list of names
// (never values).

export function getResendApiKey(): string {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error(
      "Missing RESEND_API_KEY server environment variable. Required to send " +
        "follow-up reminder/digest emails via Resend — without it, the email " +
        "provider adapter fails closed rather than silently doing nothing."
    );
  }
  return key;
}

export function getEmailFrom(): string {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error(
      "Missing EMAIL_FROM server environment variable. Must be an address on " +
        "a domain verified with the email provider (e.g. " +
        '"GAL CRM <reminders@yourdomain.com>") — required so outgoing mail is ' +
        "not rejected/spam-folder-routed."
    );
  }
  return from;
}

// Gal's own recipient address — deliberately never hardcoded in source
// (a private individual's email address must not be committed to the
// repo). Configured once as a real Vercel environment variable.
export function getGalNotificationEmail(): string {
  const email = process.env.GAL_NOTIFICATION_EMAIL;
  if (!email) {
    throw new Error(
      "Missing GAL_NOTIFICATION_EMAIL server environment variable. This is " +
        "the recipient address for follow-up reminder/digest emails — " +
        "deliberately not hardcoded in source, so it must be set explicitly."
    );
  }
  return email;
}

// Base URL used to build direct links to a Lead/Customer record inside
// the emails this system sends (e.g. https://gal-crm.example.com).
// Prefers an explicit APP_BASE_URL (so a real custom domain is used
// even across preview deployments); falls back to Vercel's own
// auto-populated production/deployment URL env vars so this works
// out of the box on a fresh Vercel deployment with zero extra config.
export function getAppBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelProdUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProdUrl) return `https://${vercelProdUrl}`;

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;

  throw new Error(
    "Missing APP_BASE_URL server environment variable (and no Vercel-provided " +
      "URL env var is set either). Required to build a direct link to a " +
      "Lead/Customer record inside notification emails."
  );
}
