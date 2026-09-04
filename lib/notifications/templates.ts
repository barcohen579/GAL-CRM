// Pure email-content builders — no I/O, no Supabase, no provider
// calls, so these are trivially unit-testable in isolation (same
// "fetch/compute split" convention as lib/crm/marketing.ts). Every
// email built here deliberately includes ONLY what the task requires:
// contact name, the follow-up's own note/reason (written by Gal
// herself), scheduled date/time, and a direct link — never phone
// numbers, financial history, or any other CRM detail the recipient
// (Gal, about her own contact) doesn't need for this one reminder.
import { formatDateTime } from "../crm/format.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EMAIL_WRAPPER_STYLE =
  "font-family: -apple-system, Segoe UI, Arial, sans-serif; background:#f4f4f5; padding:24px;";
const CARD_STYLE =
  "max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; padding:24px; border:1px solid #e4e4e7;";
const BUTTON_STYLE =
  "display:inline-block; margin-top:16px; padding:10px 20px; background:#e11d48; color:#ffffff; " +
  "text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;";

export type EmailContent = { subject: string; html: string; text: string };

// ------------------------------------------------------------------
// Individual follow-up reminder
// ------------------------------------------------------------------

export type FollowUpReminderInput = {
  contactName: string;
  /** The follow-up's own title/note — what Gal herself wrote as the
   *  reason, e.g. "ביקשה שנחזור אליה לגבי אימונים קבוצתיים". */
  reason: string;
  /** ISO timestamp — formatted here in Israel time (see
   *  lib/crm/format.ts's own Asia/Jerusalem convention). */
  dueAtIso: string;
  /** Direct, already-built link to the Lead or Customer record. */
  recordUrl: string;
};

export function buildFollowUpReminderEmail(input: FollowUpReminderInput): EmailContent {
  const { contactName, reason, dueAtIso, recordUrl } = input;
  const name = escapeHtml(contactName);
  const reasonHtml = escapeHtml(reason);
  const whenHtml = escapeHtml(formatDateTime(dueAtIso));

  const subject = `תזכורת למעקב — ${contactName}`;

  const html = `
    <div dir="rtl" lang="he" style="${EMAIL_WRAPPER_STYLE}">
      <div style="${CARD_STYLE}">
        <h1 style="margin:0 0 12px; font-size:18px; color:#18181b;">תזכורת למעקב — ${name}</h1>
        <p style="margin:0 0 8px; font-size:14px; color:#3f3f46;">הגיע הזמן לחזור אל ${name}.</p>
        <p style="margin:0 0 8px; font-size:14px; color:#3f3f46;">${reasonHtml}</p>
        <p style="margin:0 0 8px; font-size:13px; color:#71717a;">מועד: ${whenHtml}</p>
        <a href="${recordUrl}" style="${BUTTON_STYLE}">פתיחת הכרטיס ב-CRM</a>
      </div>
    </div>
  `.trim();

  const text =
    `תזכורת למעקב — ${contactName}\n\n` +
    `הגיע הזמן לחזור אל ${contactName}.\n\n` +
    `${reason}\n\n` +
    `מועד: ${formatDateTime(dueAtIso)}\n\n` +
    `פתיחת הכרטיס ב-CRM: ${recordUrl}`;

  return { subject, html, text };
}

// ------------------------------------------------------------------
// Daily digest
// ------------------------------------------------------------------

export type DigestItem = {
  /** Pre-formatted Israel-time "HH:mm", e.g. "10:00". */
  time: string;
  contactName: string;
  reason: string;
  recordUrl: string;
};

export function buildDailyDigestEmail(items: DigestItem[], dateLabel: string): EmailContent {
  const count = items.length;
  const subject = `המעקבים שלך להיום — ${count}`;

  const rowsHtml = items
    .map(
      (item) => `
        <li style="margin:0 0 10px; font-size:14px; color:#3f3f46;">
          <a href="${item.recordUrl}" style="color:#e11d48; text-decoration:none; font-weight:600;">
            ${escapeHtml(item.time)} — ${escapeHtml(item.contactName)}
          </a>
          <span style="color:#71717a;"> — ${escapeHtml(item.reason)}</span>
        </li>
      `
    )
    .join("");

  const html = `
    <div dir="rtl" lang="he" style="${EMAIL_WRAPPER_STYLE}">
      <div style="${CARD_STYLE}">
        <h1 style="margin:0 0 4px; font-size:18px; color:#18181b;">המעקבים שלך להיום — ${count}</h1>
        <p style="margin:0 0 16px; font-size:13px; color:#71717a;">${escapeHtml(dateLabel)}</p>
        <ul style="margin:0; padding-inline-start:20px;">
          ${rowsHtml}
        </ul>
      </div>
    </div>
  `.trim();

  const text =
    `המעקבים שלך להיום — ${count}\n${dateLabel}\n\n` +
    items.map((item) => `${item.time} — ${item.contactName} — ${item.reason}\n${item.recordUrl}`).join("\n\n");

  return { subject, html, text };
}
