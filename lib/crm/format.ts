// Formatting helpers. Money is always stored as integer minor units
// (agorot) — these are the only places that should ever divide by 100.
// All locale-aware formatting uses he-IL / he so dates, numbers and
// relative time read naturally in Hebrew.
//
// Every date/time formatter below renders explicitly in Asia/Jerusalem
// — Gal's own timezone — rather than whatever timezone the rendering
// server happens to be in (Vercel serverless functions default to
// UTC). Without this, a payment/lead/follow-up timestamp could display
// 2-3 hours off from what actually happened in Israel, and worse,
// silently drift by exactly one hour across DST transitions. See
// lib/crm/timezone.ts for the same Asia/Jerusalem convention applied
// to follow-up scheduling and the notification cron.

import { ISRAEL_TIME_ZONE } from "./timezone.ts";

export function formatMoney(
  minorUnits: number,
  currency: string = "ILS"
): string {
  const amount = minorUnits / 100;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatDate(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: ISRAEL_TIME_ZONE,
  }).format(d);
}

export function formatDateTime(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: ISRAEL_TIME_ZONE,
  }).format(d);
}

// "10:00" — used by the daily digest email (lib/notifications/) to
// show each follow-up's time without repeating the (already-known)
// date. Israel time, same as every other formatter in this file.
export function formatTimeOnly(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: ISRAEL_TIME_ZONE,
  }).format(d);
}

// "בעוד שעתיים", "לפני 3 ימים", "כרגע" — used for follow-up due times and
// recent-activity timestamps. Intl.RelativeTimeFormat("he") produces
// grammatically correct Hebrew (including dual forms like "שעתיים")
// rather than hand-rolled, error-prone pluralization.
const rtf = new Intl.RelativeTimeFormat("he", { numeric: "auto" });

export function formatRelative(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const diffMs = d.getTime() - new Date().getTime();
  const diffMin = Math.round(diffMs / 60000);
  const abs = Math.abs(diffMin);

  if (abs < 1) return "כרגע";
  if (abs < 60) return rtf.format(diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, "hour");
  const diffDay = Math.round(diffHr / 24);
  return rtf.format(diffDay, "day");
}

export function startOfMonthISO(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export function startOfTodayISO(): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).toISOString();
}

export function endOfTodayISO(): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999
  ).toISOString();
}

// isSameCalendarDay was removed — its one caller (app/(app)/follow-ups/
// page.tsx) needed Israel-timezone-aware day comparison, not the
// server's own local calendar day; see isSameZonedCalendarDay in
// lib/crm/timezone.ts.
