// Single factory for the configured EmailProvider. This is the ONE
// place that knows which concrete provider is active — every caller
// (the follow-up-notification cron route, its tests) depends only on
// the EmailProvider interface. Switching providers later means adding
// a new class under providers/ and changing the one line below; no
// other file in this codebase needs to know Resend ever existed.
import type { EmailProvider } from "./email-provider.ts";
import { ResendEmailProvider } from "./providers/resend.ts";

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (!cached) cached = new ResendEmailProvider();
  return cached;
}
