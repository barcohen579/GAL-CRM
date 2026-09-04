// TEMPORARY, ONE-OFF production smoke-test endpoint. NOT a scheduled
// job (deliberately has NO entry in vercel.json — must never be
// auto-invoked) and NOT meant to be committed permanently — created
// only to confirm the deployed Resend configuration
// (RESEND_API_KEY/EMAIL_FROM/GAL_NOTIFICATION_EMAIL) actually works,
// using the exact same EmailProvider adapter
// (lib/notifications/get-email-provider.ts) real reminder/digest
// emails use. DELETE THIS FILE once the smoke test is confirmed.
//
// Touches NO Supabase table of any kind — no admin client, no query,
// no Lead/Customer/follow_up_task/delivery record read or written.
// The only side effect this route can ever have is sending exactly
// one fixed-content email.
//
// Authenticated via the SAME CRON_SECRET already configured in Vercel
// Production for the other cron routes (see lib/cron/auth.ts) — no
// new secret, no new attack surface pattern. GET only.
import { getCronSecret } from "../../../../lib/cron/env.ts";
import { verifyCronAuthHeader } from "../../../../lib/cron/auth.ts";
import { getEmailProvider } from "../../../../lib/notifications/get-email-provider.ts";
import { getGalNotificationEmail } from "../../../../lib/notifications/env.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

const SUBJECT = "בדיקת התראות GAL CRM";
const HTML = `
  <div dir="rtl" lang="he" style="font-family: -apple-system, Segoe UI, Arial, sans-serif; background:#f4f4f5; padding:24px;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; padding:24px; border:1px solid #e4e4e7;">
      <p style="margin:0 0 8px; font-size:15px; color:#18181b;">מערכת ההתראות של GAL CRM מחוברת בהצלחה.</p>
      <p style="margin:0; font-size:13px; color:#71717a;">זוהי הודעת בדיקה בלבד.</p>
    </div>
  </div>
`.trim();
const TEXT = "מערכת ההתראות של GAL CRM מחוברת בהצלחה.\nזוהי הודעת בדיקה בלבד.";

export async function GET(request: Request): Promise<Response> {
  let expectedSecret: string;
  try {
    expectedSecret = getCronSecret();
  } catch {
    return new Response("Not configured.", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (!verifyCronAuthHeader(authHeader, expectedSecret)) {
    return new Response("Unauthorized.", { status: 401 });
  }

  let recipient: string;
  try {
    recipient = getGalNotificationEmail();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Notification config missing";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }

  const provider = getEmailProvider();
  const result = await provider.send({ to: recipient, subject: SUBJECT, html: HTML, text: TEXT });

  // Only a boolean + (on success) the provider's own message id — never
  // the recipient address or any secret.
  console.log(JSON.stringify({ step: "smoke_test_email_result", ok: result.ok }));

  return Response.json(result, { status: result.ok ? 200 : 502 });
}
