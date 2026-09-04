// Pure email-content builders — no I/O, no Supabase, no provider
// calls, so these are trivially unit-testable in isolation (same
// "fetch/compute split" convention as lib/crm/marketing.ts). Every
// function here takes only already-resolved, presentation-ready
// values — a Hebrew service label, a pre-built wa.me URL — never a
// raw enum value or a raw phone number; the caller (see
// app/api/cron/follow-up-notifications/route.ts) resolves those via
// lib/crm/constants.ts's SERVICE_TYPE_LABELS and
// lib/notifications/reminder-logic.ts's buildWhatsAppUrl before ever
// reaching this file. No financial or other unrelated CRM detail is
// ever included — only what a Lead/Customer reminder needs.
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
  "display:inline-block; margin-top:16px; margin-inline-end:8px; padding:10px 20px; background:#e11d48; " +
  "color:#ffffff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;";
const WHATSAPP_BUTTON_STYLE =
  "display:inline-block; margin-top:16px; margin-inline-end:8px; padding:10px 20px; background:#25d366; " +
  "color:#ffffff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;";

export type EmailContent = { subject: string; html: string; text: string };

// ------------------------------------------------------------------
// Individual follow-up reminders — two distinct templates, not one
// generic one, because the two sources genuinely have different
// content to show and must never be confused with one another:
//
//   - buildManualFollowUpReminderEmail: a MANUAL follow-up Gal herself
//     created — always shown WITH her own context (title/note) when
//     she wrote any. "One current MANUAL follow-up per Lead" (see
//     create_manual_follow_up_for_lead in
//     supabase/migrations/20260904170000_..._one_current_manual_follow_up_rpc.sql)
//     guarantees the caller can only ever reach this template with the
//     CURRENT such follow-up — a superseded older one is CANCELLED and
//     excluded before this is ever called (isReminderEligible's own
//     taskStatus check).
//   - buildAutomaticFollowUpReminderEmail: the AUTOMATIC safety-net
//     follow-up, sent only while no MANUAL one is active on the same
//     Lead (see isAutomaticEscalationEligible). Deliberately generic,
//     safety-net wording — there is no human-written context to show,
//     so this template accepts no title/notes input at all and must
//     never surface internal terms like "AUTOMATIC" or the trigger's
//     own generic task title ("מעקב אוטומטי לליד חדש").
//
// Both share the same "actions" row (an optional WhatsApp button, plus
// the CRM link, always present) — factored into the two helpers below
// so that one row is built exactly one way in both templates.
// ------------------------------------------------------------------

function actionsHtml(whatsappUrl: string | null, recordUrl: string): string {
  const whatsappLink = whatsappUrl
    ? `<a href="${whatsappUrl}" style="${WHATSAPP_BUTTON_STYLE}">פתיחת WhatsApp</a>`
    : "";
  return `${whatsappLink}<a href="${recordUrl}" style="${BUTTON_STYLE}">פתיחת הליד ב-CRM</a>`;
}

function actionsText(whatsappUrl: string | null, recordUrl: string): string {
  const lines: string[] = [];
  if (whatsappUrl) lines.push(`פתיחת WhatsApp: ${whatsappUrl}`);
  lines.push(`פתיחת הליד ב-CRM: ${recordUrl}`);
  return lines.join("\n");
}

// "מתעניינת ב: X, Y" — omitted entirely (returns null) when there are
// no interested services on file, per the task's own "if none exist,
// omit the field" requirement. `labels` are already-resolved Hebrew
// strings (SERVICE_TYPE_LABELS) — this function has no knowledge of,
// and never sees, the underlying enum values.
function interestedServicesLine(labels: string[]): string | null {
  if (labels.length === 0) return null;
  return `מתעניינת ב: ${labels.join(", ")}`;
}

export type ManualFollowUpReminderInput = {
  /** The Lead/Customer's own contact name. */
  leadName: string;
  /** The MANUAL follow-up's own title. Rendered as its own line only
   *  when it carries meaningful context beyond the lead's own name —
   *  a title that merely equals leadName (e.g. left at whatever "מעקב
   *  חדש" defaulted it to) is never shown as if it were extra
   *  context; see the `showTitle` check below. */
  title: string;
  /** Gal's own note — rendered separately and prominently under "הערה
   *  אחרונה:", never concatenated with the title. Omitted entirely
   *  (both the label and the value) when there is none. */
  notes: string | null;
  /** Already-resolved Hebrew labels (SERVICE_TYPE_LABELS in
   *  lib/crm/constants.ts) — a raw enum value such as GROUP_TRAINING
   *  must never reach this function. Empty array omits the field. */
  interestedServiceLabels: string[];
  /** ISO timestamp — formatted here in Israel time (see
   *  lib/crm/format.ts's own Asia/Jerusalem convention). */
  dueAtIso: string;
  /** Direct, already-built link to the Lead or Customer record. */
  recordUrl: string;
  /** Pre-built wa.me link (buildWhatsAppUrl in reminder-logic.ts), or
   *  null when there is no usable phone on file — the WhatsApp button
   *  is then simply omitted; the raw phone number is never included
   *  or otherwise referenced. */
  whatsappUrl: string | null;
};

export function buildManualFollowUpReminderEmail(input: ManualFollowUpReminderInput): EmailContent {
  const { leadName, title, notes, interestedServiceLabels, dueAtIso, recordUrl, whatsappUrl } = input;
  const name = escapeHtml(leadName);
  const showTitle = title.trim() !== leadName.trim();
  const whenLabel = formatDateTime(dueAtIso);
  const servicesLine = interestedServicesLine(interestedServiceLabels);

  const subject = `תזכורת למעקב – ${leadName}`;

  const titleHtml = showTitle
    ? `<p style="margin:0 0 8px; font-size:14px; color:#3f3f46;">${escapeHtml(title)}</p>`
    : "";
  const notesHtml = notes
    ? `<div style="margin:0 0 12px; padding:12px; background:#fafafa; border-radius:8px; border:1px solid #e4e4e7;">
        <p style="margin:0 0 4px; font-size:13px; font-weight:700; color:#18181b;">הערה אחרונה:</p>
        <p style="margin:0; font-size:14px; color:#3f3f46;">${escapeHtml(notes)}</p>
      </div>`
    : "";
  const servicesHtml = servicesLine
    ? `<p style="margin:0 0 8px; font-size:13px; color:#71717a;">${escapeHtml(servicesLine)}</p>`
    : "";

  const html = `
    <div dir="rtl" lang="he" style="${EMAIL_WRAPPER_STYLE}">
      <div style="${CARD_STYLE}">
        <h1 style="margin:0 0 12px; font-size:18px; color:#18181b;">תזכורת למעקב – ${name}</h1>
        <p style="margin:0 0 8px; font-size:14px; color:#3f3f46;">הגיע הזמן לחזור אל ${name}.</p>
        ${titleHtml}
        ${notesHtml}
        ${servicesHtml}
        <p style="margin:0 0 8px; font-size:13px; color:#71717a;">מועד המעקב: ${escapeHtml(whenLabel)}</p>
        ${actionsHtml(whatsappUrl, recordUrl)}
      </div>
    </div>
  `.trim();

  const textLines: string[] = [subject, "", `הגיע הזמן לחזור אל ${leadName}.`];
  if (showTitle) textLines.push("", title);
  if (notes) textLines.push("", "הערה אחרונה:", notes);
  if (servicesLine) textLines.push("", servicesLine);
  textLines.push("", `מועד המעקב: ${whenLabel}`);
  textLines.push("", actionsText(whatsappUrl, recordUrl));

  return { subject, html, text: textLines.join("\n") };
}

export type AutomaticFollowUpReminderInput = {
  /** The Lead's own contact name. */
  leadName: string;
  /** Already-resolved Hebrew labels — see ManualFollowUpReminderInput. */
  interestedServiceLabels: string[];
  recordUrl: string;
  /** See ManualFollowUpReminderInput — same contract. */
  whatsappUrl: string | null;
};

export function buildAutomaticFollowUpReminderEmail(input: AutomaticFollowUpReminderInput): EmailContent {
  const { leadName, interestedServiceLabels, recordUrl, whatsappUrl } = input;
  const name = escapeHtml(leadName);
  const servicesLine = interestedServicesLine(interestedServiceLabels);
  const servicesHtml = servicesLine
    ? `<p style="margin:0 0 8px; font-size:13px; color:#71717a;">${escapeHtml(servicesLine)}</p>`
    : "";

  const subject = `תזכורת לליד פתוח – ${leadName}`;

  const html = `
    <div dir="rtl" lang="he" style="${EMAIL_WRAPPER_STYLE}">
      <div style="${CARD_STYLE}">
        <h1 style="margin:0 0 12px; font-size:18px; color:#18181b;">תזכורת לליד פתוח – ${name}</h1>
        <p style="margin:0 0 8px; font-size:14px; color:#3f3f46;">${name} עדיין פתוחה ואין כרגע מעקב ידני פעיל.</p>
        <p style="margin:0 0 8px; font-size:14px; color:#3f3f46;">זה הזמן לבדוק אם צריך לחזור אליה.</p>
        ${servicesHtml}
        ${actionsHtml(whatsappUrl, recordUrl)}
      </div>
    </div>
  `.trim();

  const textLines: string[] = [
    subject,
    "",
    `${leadName} עדיין פתוחה ואין כרגע מעקב ידני פעיל.`,
    "",
    "זה הזמן לבדוק אם צריך לחזור אליה.",
  ];
  if (servicesLine) textLines.push("", servicesLine);
  textLines.push("", actionsText(whatsappUrl, recordUrl));

  return { subject, html, text: textLines.join("\n") };
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
