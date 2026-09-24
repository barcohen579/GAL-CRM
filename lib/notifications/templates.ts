// Pure email-content builders for the two Lead Workflow V2 reminder
// emails — no I/O. Every input is already presentation-ready (Hebrew
// labels, a pre-built wa.me URL); the caller (lib/notifications/
// reminder-job.ts) resolves those. No financial or unrelated CRM detail
// is ever included.
//
//   - buildNewLeadReminderEmail:  "תזכורת לליד חדש — {name}" — the ONE
//     reminder for a new lead's AUTOMATIC task.
//   - buildManualFollowUpReminderEmail: "מעקב שטרם הושלם — {name}" — the
//     ONE reminder for a MANUAL follow-up still open after its due date.
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

export type LatestConversation = {
  /** Hebrew outcome label, e.g. "ביקשה מחירים / פרטים". */
  outcomeLabel: string;
  note: string | null;
  atIso: string;
};

type Row = { label: string; value: string };

function rowsHtml(rows: Row[]): string {
  return rows
    .map(
      (row) => `
        <p style="margin:0 0 6px; font-size:14px; color:#3f3f46;">
          <span style="color:#71717a;">${escapeHtml(row.label)}:</span> ${escapeHtml(row.value)}
        </p>`
    )
    .join("");
}

function conversationRows(latest: LatestConversation | null): Row[] {
  if (!latest) return [];
  const rows: Row[] = [
    { label: "שיחה אחרונה", value: `${latest.outcomeLabel} (${formatDateTime(latest.atIso)})` },
  ];
  if (latest.note) rows.push({ label: "הערה מהשיחה", value: latest.note });
  return rows;
}

function actionsHtml(whatsappUrl: string | null, recordUrl: string, recordLabel: string): string {
  const whatsappLink = whatsappUrl
    ? `<a href="${escapeHtml(whatsappUrl)}" style="${WHATSAPP_BUTTON_STYLE}">פתיחת WhatsApp</a>`
    : "";
  return `${whatsappLink}<a href="${escapeHtml(recordUrl)}" style="${BUTTON_STYLE}">${escapeHtml(recordLabel)}</a>`;
}

function actionsText(whatsappUrl: string | null, recordUrl: string, recordLabel: string): string {
  const lines: string[] = [];
  if (whatsappUrl) lines.push(`פתיחת WhatsApp: ${whatsappUrl}`);
  lines.push(`${recordLabel}: ${recordUrl}`);
  return lines.join("\n");
}

function render(params: {
  subject: string;
  heading: string;
  intro: string;
  rows: Row[];
  whatsappUrl: string | null;
  recordUrl: string;
  recordLabel: string;
}): EmailContent {
  const { subject, heading, intro, rows, whatsappUrl, recordUrl, recordLabel } = params;
  const html = `
    <div dir="rtl" lang="he" style="${EMAIL_WRAPPER_STYLE}">
      <div style="${CARD_STYLE}">
        <h1 style="margin:0 0 12px; font-size:18px; color:#18181b;">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 12px; font-size:14px; color:#3f3f46;">${escapeHtml(intro)}</p>
        ${rowsHtml(rows)}
        ${actionsHtml(whatsappUrl, recordUrl, recordLabel)}
      </div>
    </div>
  `.trim();

  const text = [
    subject,
    "",
    intro,
    "",
    ...rows.map((row) => `${row.label}: ${row.value}`),
    "",
    actionsText(whatsappUrl, recordUrl, recordLabel),
  ].join("\n");

  return { subject, html, text };
}

export type NewLeadReminderInput = {
  leadName: string;
  phone: string | null;
  /** Hebrew stage label (LEAD_STAGE_LABELS). */
  stageLabel: string;
  /** Hebrew service labels (SERVICE_TYPE_LABELS); empty omits the row. */
  interestedServiceLabels: string[];
  /** Hebrew primary-source label, or null when unknown. */
  sourceLabel: string | null;
  leadCreatedAtIso: string;
  latestConversation: LatestConversation | null;
  recordUrl: string;
  /** Pre-built wa.me link, or null when there is no valid phone. */
  whatsappUrl: string | null;
};

export function buildNewLeadReminderEmail(input: NewLeadReminderInput): EmailContent {
  const rows: Row[] = [{ label: "שם", value: input.leadName }];
  if (input.phone) rows.push({ label: "טלפון", value: input.phone });
  rows.push({ label: "שלב", value: input.stageLabel });
  if (input.interestedServiceLabels.length > 0) {
    rows.push({ label: "מתעניינת ב", value: input.interestedServiceLabels.join(", ") });
  }
  if (input.sourceLabel) rows.push({ label: "מקור", value: input.sourceLabel });
  rows.push({ label: "נכנס ל-CRM", value: formatDateTime(input.leadCreatedAtIso) });
  rows.push(...conversationRows(input.latestConversation));

  return render({
    subject: `תזכורת לליד חדש — ${input.leadName}`,
    heading: `תזכורת לליד חדש — ${input.leadName}`,
    intro: "ליד חדש שעדיין לא נוצר איתו קשר. זו התזכורת היחידה שתישלח על הליד הזה.",
    rows,
    whatsappUrl: input.whatsappUrl,
    recordUrl: input.recordUrl,
    recordLabel: "פתיחת הליד ב-CRM",
  });
}

export type ManualFollowUpReminderInput = {
  /** Lead or customer contact name. */
  name: string;
  phone: string | null;
  /** Hebrew lead stage label, or null for a customer follow-up. */
  stageLabel: string | null;
  isCustomer: boolean;
  interestedServiceLabels: string[];
  /** What Gal wrote she needs to do. */
  title: string;
  notes: string | null;
  dueAtIso: string;
  latestConversation: LatestConversation | null;
  recordUrl: string;
  whatsappUrl: string | null;
};

export function buildManualFollowUpReminderEmail(input: ManualFollowUpReminderInput): EmailContent {
  const rows: Row[] = [{ label: "שם", value: input.name }];
  if (input.phone) rows.push({ label: "טלפון", value: input.phone });
  rows.push({ label: "מה צריך לעשות", value: input.title });
  if (input.notes) rows.push({ label: "הערה", value: input.notes });
  rows.push({ label: "מועד המעקב", value: formatDateTime(input.dueAtIso) });
  rows.push({ label: "שלב", value: input.stageLabel ?? "לקוחה" });
  if (input.interestedServiceLabels.length > 0) {
    rows.push({ label: "מתעניינת ב", value: input.interestedServiceLabels.join(", ") });
  }
  rows.push(...conversationRows(input.latestConversation));

  return render({
    subject: `מעקב שטרם הושלם — ${input.name}`,
    heading: `מעקב שטרם הושלם — ${input.name}`,
    intro: "המעקב הזה עדיין פתוח ב-CRM. זו התזכורת היחידה שתישלח עליו.",
    rows,
    whatsappUrl: input.whatsappUrl,
    recordUrl: input.recordUrl,
    recordLabel: input.isCustomer ? "פתיחת הלקוחה ב-CRM" : "פתיחת הליד ב-CRM",
  });
}
