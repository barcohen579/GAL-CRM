// Israel-timezone helpers. Every CRM/user-facing follow-up time must
// be interpreted and displayed consistently in Asia/Jerusalem — never
// silently in whatever timezone the server process happens to run in
// (Vercel serverless functions default to UTC), and never naively
// offset by a fixed +2/+3 hours (Israel observes DST — Asia/Jerusalem's
// offset is +2 in winter, +3 in summer, on Israeli-specific transition
// dates that don't line up with US/EU DST). All of this goes through
// Intl/ICU's real IANA tz database (via the `timeZone` option below),
// never hand-rolled arithmetic, so DST is handled correctly for free.

export const ISRAEL_TIME_ZONE = "Asia/Jerusalem";

/** The UTC offset (in minutes, e.g. 180 for +03:00) Asia/Jerusalem has
 *  at the given instant. Positive = ahead of UTC (always true for
 *  Israel, but computed generically). Internal helper — exported only
 *  for tests. */
export function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(instant);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const match = /GMT([+-])(\d+)(?::(\d+))?/.exec(raw);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  return sign * (hours * 60 + minutes);
}

/** Converts a "wall clock" date+time as it would read on a clock in
 *  `timeZone` into the correct UTC instant, returned as an ISO string.
 *  E.g. zonedWallTimeToUtcIso("2026-10-15", "10:00", ISRAEL_TIME_ZONE)
 *  -> the UTC instant that is 10:00 in Israel on that date, correctly
 *  accounting for whichever DST offset applies on Oct 15.
 *
 *  Implementation: a standard two-pass fixed-point refinement (no
 *  timezone library dependency, matching this codebase's existing
 *  "plain fetch / Intl only" convention — see lib/meta/graph.ts).
 *  Pass 1 guesses the offset from an approximate instant; pass 2
 *  re-derives it from the corrected instant, which converges correctly
 *  even within a few hours of a DST transition (the only case where a
 *  single pass could pick the wrong side of the transition). Real-world
 *  timezones change offset at most twice a year by a whole/half hour,
 *  so two passes is enough — this is not a general-purpose tz library,
 *  just what this feature needs. */
export function zonedWallTimeToUtcIso(
  dateStr: string,
  timeStr: string,
  timeZone: string = ISRAEL_TIME_ZONE
): string {
  const naiveMs = Date.parse(`${dateStr}T${timeStr}:00.000Z`);
  let guessMs = naiveMs;
  for (let i = 0; i < 2; i++) {
    const offsetMin = timeZoneOffsetMinutes(new Date(guessMs), timeZone);
    guessMs = naiveMs - offsetMin * 60000;
  }
  return new Date(guessMs).toISOString();
}

export type ZonedParts = {
  /** "YYYY-MM-DD" calendar date in the target timezone. */
  dateKey: string;
  hour: number;
  minute: number;
};

/** Reads the wall-clock date/hour/minute a given instant (default: now)
 *  corresponds to in `timeZone`. Used for "is it past 08:00 Israel time
 *  yet" / "what is today's Israel calendar date" decisions — never
 *  derived from the server's own local Date methods (getHours() etc.),
 *  which reflect the SERVER's timezone, not Israel's. */
export function zonedParts(instant: Date = new Date(), timeZone: string = ISRAEL_TIME_ZONE): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // en-CA gives YYYY-MM-DD ordering for date parts, exactly what dateKey needs.
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  // hour12: false can format midnight as "24" in some ICU versions —
  // normalize to 0 so downstream hour comparisons never see a bogus 24.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { dateKey, hour, minute };
}

/** Adds (or subtracts, for negative `days`) whole calendar days to a
 *  "YYYY-MM-DD" date key. Pure calendar-label arithmetic — deliberately
 *  anchored to UTC internally (never a target timezone's offset) since
 *  a date KEY has no time-of-day/offset to begin with; used to compute
 *  "tomorrow" for a day's [start, end) query bounds (see
 *  zonedWallTimeToUtcIso for turning each end back into a real instant
 *  in `timeZone`). */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** True when both instants fall on the same calendar day in `timeZone`
 *  — the Israel-aware replacement for comparing two Dates' own
 *  getFullYear/getMonth/getDate (which reflect the SERVER's timezone,
 *  not Israel's, and would misclassify "today" near midnight). */
export function isSameZonedCalendarDay(
  a: Date,
  b: Date,
  timeZone: string = ISRAEL_TIME_ZONE
): boolean {
  return zonedParts(a, timeZone).dateKey === zonedParts(b, timeZone).dateKey;
}

// ------------------------------------------------------------------
// Follow-up business-day (quiet-weekend) semantics — Automatic Lead
// Follow-Up Escalation Loop's explicit business rule: no lead follow-up
// reminders, no follow-up emails, and no automatic escalation occurrence
// is ever due on Friday or Saturday (Israel calendar day) — everything
// that would land there defers to Sunday. Every function below is pure
// calendar-label arithmetic on a "YYYY-MM-DD" dateKey (same convention
// as addDaysToDateKey — a date key has no time-of-day/offset of its
// own, so anchoring the day-of-week read on UTC midnight of that label
// is correct and DST-irrelevant by construction), never a fixed-offset
// guess. Converting a real instant (e.g. "now") into a dateKey still
// goes through zonedParts, which IS DST-safe via real IANA tz data.
// ------------------------------------------------------------------

/** 0 (Sunday) .. 6 (Saturday) for a "YYYY-MM-DD" calendar-date label —
 *  pure calendar-label arithmetic, see this section's own header. */
export function dayOfWeekFromDateKey(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

/** Eligible days are Sunday..Thursday; Friday/Saturday are the quiet
 *  weekend — no reminder, digest, or escalation occurrence is ever due
 *  on them. */
export function isEligibleFollowUpDateKey(dateKey: string): boolean {
  const dow = dayOfWeekFromDateKey(dateKey);
  return dow !== 5 && dow !== 6; // 5 = Friday, 6 = Saturday
}

/** Whether `instant` (default: now), read as a real Israel calendar day
 *  via zonedParts, is an eligible follow-up business day — the single
 *  gate every notification path (individual reminder, daily digest,
 *  automatic escalation) checks before sending anything today. */
export function isFollowUpBusinessDay(
  instant: Date = new Date(),
  timeZone: string = ISRAEL_TIME_ZONE
): boolean {
  return isEligibleFollowUpDateKey(zonedParts(instant, timeZone).dateKey);
}

/** The next eligible Israel calendar date strictly after `dateKey` —
 *  "the next day, skipping Friday/Saturday". Used both for a new lead's
 *  Day-0 -> first-automatic-follow-up date, and conceptually mirrored in
 *  SQL by next_eligible_follow_up_date() (see the escalation migration)
 *  for the trigger that actually creates that row. Thu -> Sun, Fri ->
 *  Sun, Sat -> Sun, every other day -> the very next calendar day. */
export function nextEligibleFollowUpDay(dateKey: string): string {
  let next = addDaysToDateKey(dateKey, 1);
  while (!isEligibleFollowUpDateKey(next)) {
    next = addDaysToDateKey(next, 1);
  }
  return next;
}

/** The exact instant (UTC ISO string) a new Lead's Day-0 AUTOMATIC
 *  follow-up is due: 10:00 Israel time on nextEligibleFollowUpDay of
 *  the lead's own creation date — regardless of what time of day the
 *  lead was actually created (a Sunday 08:00 lead and a Sunday 23:30
 *  lead both land on Monday 10:00). Pure TS mirror of the SQL trigger
 *  create_automatic_followup_for_new_lead() (see
 *  supabase/migrations/20260904190000_..._automatic_followup_10am.sql)
 *  — not called by any application code path (the DB trigger is the
 *  actual, authoritative implementation that runs on every real lead
 *  insert), kept here purely so this one rule has a fast, DB-free test
 *  surface documenting exactly what the trigger is expected to do —
 *  same "SQL mirror, TS test surface" precedent as
 *  nextEligibleFollowUpDay/next_eligible_follow_up_date itself.
 *  MANUAL follow-ups never go through this function — Gal's own
 *  explicitly chosen date/time is stored exactly as given, in both the
 *  DB (create_manual_follow_up_for_lead) and the app layer
 *  (createFollowUp) — see this repo's own regression tests for that
 *  guarantee. */
export function automaticFollowUpDueAtIso(
  leadCreatedAtIso: string,
  timeZone: string = ISRAEL_TIME_ZONE
): string {
  const createdAtDateKey = zonedParts(new Date(leadCreatedAtIso), timeZone).dateKey;
  const dueDateKey = nextEligibleFollowUpDay(createdAtDateKey);
  return zonedWallTimeToUtcIso(dueDateKey, "10:00", timeZone);
}
