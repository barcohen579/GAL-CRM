// Provider-independent email-sending interface. Business logic (the
// follow-up-notification cron route) depends ONLY on this shape — never
// on Resend, or any other vendor, directly. Swapping providers later
// means writing one new class implementing EmailProvider and changing
// the single factory in get-email-provider.ts; nothing else in this
// codebase needs to change.

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  /** Plain-text fallback — good practice for deliverability, and what
   *  keeps every email this system sends readable even in a client
   *  that can't/won't render HTML. */
  text: string;
};

export type EmailSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string };

export interface EmailProvider {
  /** Never throws — every failure mode (missing config, network error,
   *  non-2xx response, malformed provider response) is reported as
   *  `{ ok: false, error }`, so a caller can always safely record the
   *  attempt without a try/catch. `error` is a plain, secret-free
   *  message safe to persist in follow_up_reminder_deliveries.last_error
   *  / daily_digest_deliveries.last_error. */
  send(message: EmailMessage): Promise<EmailSendResult>;
}
