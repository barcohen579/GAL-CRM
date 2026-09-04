// Resend (https://resend.com) email provider adapter. Plain fetch, no
// SDK dependency — same convention as lib/meta/graph.ts's own Graph
// API calls. This is the ONLY file in the codebase that knows Resend's
// specific request/response shape; everything else depends on the
// generic EmailProvider interface (see ../email-provider.ts).
//
// Why Resend: no existing email provider was found anywhere in this
// project (grepped package.json and the whole repo before choosing).
// Resend has a minimal REST API well-suited to a small production
// app's occasional transactional emails, requires no npm dependency
// (a single POST with a Bearer token), and needs only a verified
// sending domain to operate reliably — see docs/follow-up-notifications.md
// for the exact manual setup steps.
import { getResendApiKey, getEmailFrom } from "../env.ts";
import type { EmailProvider, EmailMessage, EmailSendResult } from "../email-provider.ts";

const RESEND_API_URL = "https://api.resend.com/emails";

// Same conservative-timeout convention as lib/meta/graph.ts's
// META_REQUEST_TIMEOUT_MS — an email send is small and fast; this is
// headroom against a slow network, not an expected duration.
const REQUEST_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Resend API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class ResendEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    let apiKey: string;
    let from: string;
    try {
      apiKey = getResendApiKey();
      from = getEmailFrom();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Email provider not configured" };
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });
    } catch (err) {
      // Never include the request (which carries the Authorization
      // header) in the thrown/returned error — only a fixed,
      // human-readable description, same discipline as
      // lib/meta/graph.ts's fetchWithTimeout.
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Network error sending email",
      };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const body = (json ?? {}) as { id?: unknown; message?: unknown };

    if (!res.ok) {
      const providerMessage = typeof body.message === "string" ? body.message : "no message";
      return { ok: false, error: `Resend API error (HTTP ${res.status}): ${providerMessage}` };
    }

    // Do not mark a send as successful without a real confirmation id
    // from the provider — an HTTP 2xx with an unexpected body is
    // treated as NOT confirmed, per this system's own explicit
    // "never mark SENT until the provider actually confirms" rule.
    if (typeof body.id !== "string" || body.id.length === 0) {
      return {
        ok: false,
        error: "Resend API returned a success status without a message id — treating as unconfirmed",
      };
    }

    return { ok: true, providerMessageId: body.id };
  }
}
