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
