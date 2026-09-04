import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISRAEL_TIME_ZONE,
  zonedWallTimeToUtcIso,
  zonedParts,
  isSameZonedCalendarDay,
  timeZoneOffsetMinutes,
  dayOfWeekFromDateKey,
  isEligibleFollowUpDateKey,
  isFollowUpBusinessDay,
  nextEligibleFollowUpDay,
  automaticFollowUpDueAtIso,
} from "./timezone.ts";

// ------------------------------------------------------------------
// timeZoneOffsetMinutes — the DST-sensitive building block
// ------------------------------------------------------------------

test("timeZoneOffsetMinutes: Israel Standard Time (winter) is UTC+2", () => {
  // January is unambiguously IST in Israel.
  const offset = timeZoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), ISRAEL_TIME_ZONE);
  assert.equal(offset, 120);
});

test("timeZoneOffsetMinutes: Israel Daylight Time (summer) is UTC+3", () => {
  // July is unambiguously IDT in Israel.
  const offset = timeZoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), ISRAEL_TIME_ZONE);
  assert.equal(offset, 180);
});

// ------------------------------------------------------------------
// zonedWallTimeToUtcIso — the actual conversion createFollowUp needs:
// "10:00 in Israel" must become the correct UTC instant, not 10:00 UTC.
// ------------------------------------------------------------------

test("zonedWallTimeToUtcIso: 10:00 Israel time in winter (IST, UTC+2) -> 08:00 UTC", () => {
  const iso = zonedWallTimeToUtcIso("2026-01-15", "10:00", ISRAEL_TIME_ZONE);
  assert.equal(iso, "2026-01-15T08:00:00.000Z");
});

test("zonedWallTimeToUtcIso: 10:00 Israel time in summer (IDT, UTC+3) -> 07:00 UTC", () => {
  const iso = zonedWallTimeToUtcIso("2026-07-15", "10:00", ISRAEL_TIME_ZONE);
  assert.equal(iso, "2026-07-15T07:00:00.000Z");
});

test("zonedWallTimeToUtcIso: never accidentally treats Israel wall-clock time as UTC time", () => {
  const iso = zonedWallTimeToUtcIso("2026-09-05", "10:00", ISRAEL_TIME_ZONE);
  assert.notEqual(iso, "2026-09-05T10:00:00.000Z", "must not equal the naive (wrong) 10:00 UTC interpretation");
});

test("zonedWallTimeToUtcIso: midnight-crossing wall time (23:30 Israel) lands on the correct UTC day", () => {
  // 23:30 IDT (UTC+3) on Aug 10 = 20:30 UTC on Aug 10 (does not cross midnight this direction).
  const iso = zonedWallTimeToUtcIso("2026-08-10", "23:30", ISRAEL_TIME_ZONE);
  assert.equal(iso, "2026-08-10T20:30:00.000Z");
});

test("zonedWallTimeToUtcIso: early-morning wall time (01:00 Israel) rolls back to the previous UTC day", () => {
  // 01:00 IDT (UTC+3) on Aug 10 = 22:00 UTC on Aug 9.
  const iso = zonedWallTimeToUtcIso("2026-08-10", "01:00", ISRAEL_TIME_ZONE);
  assert.equal(iso, "2026-08-09T22:00:00.000Z");
});

// ------------------------------------------------------------------
// zonedParts — reading Israel wall-clock date/hour/minute back out of
// a UTC instant (what the cron uses to decide "is it >= 08:00 Israel
// time yet" and "what is today's Israel calendar date").
// ------------------------------------------------------------------

test("zonedParts: round-trips a known Israel wall-clock time (winter)", () => {
  const parts = zonedParts(new Date("2026-01-15T08:00:00.000Z"), ISRAEL_TIME_ZONE);
  assert.deepEqual(parts, { dateKey: "2026-01-15", hour: 10, minute: 0 });
});

test("zonedParts: round-trips a known Israel wall-clock time (summer)", () => {
  const parts = zonedParts(new Date("2026-07-15T07:00:00.000Z"), ISRAEL_TIME_ZONE);
  assert.deepEqual(parts, { dateKey: "2026-07-15", hour: 10, minute: 0 });
});

test("zonedParts: an instant just before Israel midnight and one just after fall on different Israel dateKeys", () => {
  // 2026-08-09T20:59:00Z = 2026-08-09 23:59 IDT; 2026-08-09T21:01:00Z = 2026-08-10 00:01 IDT.
  const before = zonedParts(new Date("2026-08-09T20:59:00.000Z"), ISRAEL_TIME_ZONE);
  const after = zonedParts(new Date("2026-08-09T21:01:00.000Z"), ISRAEL_TIME_ZONE);
  assert.equal(before.dateKey, "2026-08-09");
  assert.equal(after.dateKey, "2026-08-10");
});

// ------------------------------------------------------------------
// isSameZonedCalendarDay
// ------------------------------------------------------------------

test("isSameZonedCalendarDay: two instants that are the same UTC day but different Israel days are correctly NOT the same", () => {
  // 2026-08-09T21:30:00Z (00:30 Israel on the 10th) vs 2026-08-09T10:00:00Z
  // (13:00 Israel on the 9th) — same UTC calendar day (Aug 9), but
  // different Israel calendar days.
  const a = new Date("2026-08-09T21:30:00.000Z");
  const b = new Date("2026-08-09T10:00:00.000Z");
  assert.equal(isSameZonedCalendarDay(a, b, ISRAEL_TIME_ZONE), false);
});

test("isSameZonedCalendarDay: two instants that are DIFFERENT UTC days but the SAME Israel day are correctly identified as same", () => {
  // 2026-08-09T22:00:00Z = 2026-08-10 01:00 IDT; 2026-08-10T05:00:00Z = 2026-08-10 08:00 IDT.
  const a = new Date("2026-08-09T22:00:00.000Z");
  const b = new Date("2026-08-10T05:00:00.000Z");
  assert.equal(isSameZonedCalendarDay(a, b, ISRAEL_TIME_ZONE), true);
});

test("isSameZonedCalendarDay: identical instants are always the same day", () => {
  const d = new Date();
  assert.equal(isSameZonedCalendarDay(d, d, ISRAEL_TIME_ZONE), true);
});

// ------------------------------------------------------------------
// Follow-up quiet-weekend semantics (§2/§11 of the escalation spec):
// no reminder/digest/escalation is ever due on Friday or Saturday.
// ------------------------------------------------------------------

test("dayOfWeekFromDateKey: known dates map to the correct day of week", () => {
  assert.equal(dayOfWeekFromDateKey("2026-09-06"), 0); // Sunday
  assert.equal(dayOfWeekFromDateKey("2026-09-07"), 1); // Monday
  assert.equal(dayOfWeekFromDateKey("2026-09-10"), 4); // Thursday
  assert.equal(dayOfWeekFromDateKey("2026-09-11"), 5); // Friday
  assert.equal(dayOfWeekFromDateKey("2026-09-12"), 6); // Saturday
});

test("isEligibleFollowUpDateKey: Sunday..Thursday are eligible, Friday/Saturday are not", () => {
  assert.equal(isEligibleFollowUpDateKey("2026-09-06"), true); // Sun
  assert.equal(isEligibleFollowUpDateKey("2026-09-07"), true); // Mon
  assert.equal(isEligibleFollowUpDateKey("2026-09-08"), true); // Tue
  assert.equal(isEligibleFollowUpDateKey("2026-09-09"), true); // Wed
  assert.equal(isEligibleFollowUpDateKey("2026-09-10"), true); // Thu
  assert.equal(isEligibleFollowUpDateKey("2026-09-11"), false); // Fri
  assert.equal(isEligibleFollowUpDateKey("2026-09-12"), false); // Sat
});

test("isFollowUpBusinessDay: reads the real Israel calendar day of an instant, not the server's own", () => {
  // 2026-09-11T21:30:00Z = 2026-09-12 00:30 IDT (already Saturday in Israel).
  assert.equal(isFollowUpBusinessDay(new Date("2026-09-11T21:30:00.000Z"), ISRAEL_TIME_ZONE), false);
  // 2026-09-13T21:30:00Z = 2026-09-14 00:30 IDT (already Monday in Israel).
  assert.equal(isFollowUpBusinessDay(new Date("2026-09-13T21:30:00.000Z"), ISRAEL_TIME_ZONE), true);
});

test("nextEligibleFollowUpDay: a lead entering Sunday..Wednesday gets the very next day", () => {
  assert.equal(nextEligibleFollowUpDay("2026-09-06"), "2026-09-07"); // Sun -> Mon
  assert.equal(nextEligibleFollowUpDay("2026-09-07"), "2026-09-08"); // Mon -> Tue
  assert.equal(nextEligibleFollowUpDay("2026-09-08"), "2026-09-09"); // Tue -> Wed
  assert.equal(nextEligibleFollowUpDay("2026-09-09"), "2026-09-10"); // Wed -> Thu
});

test("nextEligibleFollowUpDay: a lead entering Thursday skips Friday, lands Sunday", () => {
  assert.equal(nextEligibleFollowUpDay("2026-09-10"), "2026-09-13"); // Thu -> Sun
});

test("nextEligibleFollowUpDay: a lead entering Friday skips straight to Sunday", () => {
  assert.equal(nextEligibleFollowUpDay("2026-09-11"), "2026-09-13"); // Fri -> Sun
});

test("nextEligibleFollowUpDay: a lead entering Saturday lands on the very next day, Sunday", () => {
  assert.equal(nextEligibleFollowUpDay("2026-09-12"), "2026-09-13"); // Sat -> Sun
});

// ------------------------------------------------------------------
// automaticFollowUpDueAtIso — "Automatic Lead Follow-Up Always at
// 10:00 Next Eligible Day": every worked example from the task's own
// spec, expressed as an exact instant, plus the time-of-day-doesn't-
// matter and DST-boundary cases the spec explicitly calls for.
// ------------------------------------------------------------------

test("automaticFollowUpDueAtIso: Sunday -> Monday 10:00", () => {
  // 2026-09-06T05:00:00Z = Sunday 08:00 IDT (matches the task's own
  // "Sunday 08:00 Lead -> Monday 10:00" example).
  assert.equal(
    automaticFollowUpDueAtIso("2026-09-06T05:00:00.000Z"),
    zonedWallTimeToUtcIso("2026-09-07", "10:00", ISRAEL_TIME_ZONE)
  );
});

test("automaticFollowUpDueAtIso: Monday -> Tuesday 10:00", () => {
  assert.equal(
    automaticFollowUpDueAtIso("2026-09-07T09:00:00.000Z"), // Monday ~12:00 IDT
    zonedWallTimeToUtcIso("2026-09-08", "10:00", ISRAEL_TIME_ZONE)
  );
});

test("automaticFollowUpDueAtIso: Wednesday -> Thursday 10:00", () => {
  // 2026-09-09T14:00:00Z = Wednesday 17:00 IDT (matches the task's own
  // "Wednesday 17:00 Lead -> Thursday 10:00" example).
  assert.equal(
    automaticFollowUpDueAtIso("2026-09-09T14:00:00.000Z"),
    zonedWallTimeToUtcIso("2026-09-10", "10:00", ISRAEL_TIME_ZONE)
  );
});

test("automaticFollowUpDueAtIso: Thursday -> Sunday 10:00 (skips Friday/Saturday)", () => {
  // 2026-09-10T06:00:00Z = Thursday 09:00 IDT (matches the task's own
  // "Thursday 09:00 Lead -> Sunday 10:00" example).
  assert.equal(
    automaticFollowUpDueAtIso("2026-09-10T06:00:00.000Z"),
    zonedWallTimeToUtcIso("2026-09-13", "10:00", ISRAEL_TIME_ZONE)
  );
});

test("automaticFollowUpDueAtIso: Friday -> Sunday 10:00", () => {
  assert.equal(
    automaticFollowUpDueAtIso("2026-09-11T09:00:00.000Z"), // Friday ~12:00 IDT
    zonedWallTimeToUtcIso("2026-09-13", "10:00", ISRAEL_TIME_ZONE)
  );
});

test("automaticFollowUpDueAtIso: Saturday -> Sunday 10:00", () => {
  assert.equal(
    automaticFollowUpDueAtIso("2026-09-12T09:00:00.000Z"), // Saturday ~12:00 IDT
    zonedWallTimeToUtcIso("2026-09-13", "10:00", ISRAEL_TIME_ZONE)
  );
});

test("automaticFollowUpDueAtIso: a late-night lead (Sunday 23:30 Israel) still lands on the very next eligible day, 10:00 — not pushed an extra day by the late hour", () => {
  // 2026-09-06T20:30:00Z = Sunday 23:30 IDT (matches the task's own
  // "Sunday 23:30 Lead -> Monday 10:00" example) — the very definition
  // of "regardless of what time it enters the CRM".
  assert.equal(
    automaticFollowUpDueAtIso("2026-09-06T20:30:00.000Z"),
    zonedWallTimeToUtcIso("2026-09-07", "10:00", ISRAEL_TIME_ZONE)
  );
});

test("automaticFollowUpDueAtIso: Thursday 22:00 Israel still resolves to Sunday 10:00, same as Thursday 09:00", () => {
  // 2026-09-10T19:00:00Z = Thursday 22:00 IDT (matches the task's own
  // "Thursday 22:00 Lead -> Sunday 10:00" example) — confirms
  // time-of-day never changes which day is picked.
  assert.equal(
    automaticFollowUpDueAtIso("2026-09-10T19:00:00.000Z"),
    zonedWallTimeToUtcIso("2026-09-13", "10:00", ISRAEL_TIME_ZONE)
  );
});

test("automaticFollowUpDueAtIso: DST-safe across the actual Israel DST-end boundary (2026-10-25) — lands on IST (UTC+2), not the pre-transition IDT offset", () => {
  // 2026-10-22T19:00:00Z = Thursday 22:00 IDT (UTC+3) -- still daylight
  // time. Skips Friday 2026-10-23 / Saturday 2026-10-24 and lands on
  // Sunday 2026-10-25 -- the very day Israel's clocks fall back from
  // IDT to IST at 02:00 local. By 10:00 that day Israel is already on
  // IST (UTC+2), so the correct UTC instant is 08:00, NOT 07:00 (which
  // a naive "always +3" offset would wrongly produce).
  const iso = automaticFollowUpDueAtIso("2026-10-22T19:00:00.000Z");
  assert.equal(iso, "2026-10-25T08:00:00.000Z");
  assert.equal(iso, zonedWallTimeToUtcIso("2026-10-25", "10:00", ISRAEL_TIME_ZONE));
});

test("automaticFollowUpDueAtIso: DST-safe across the actual Israel DST-start boundary (2026-03-27) — lands on IDT (UTC+3)", () => {
  // 2026-03-26T10:00:00Z = Thursday ~12:00 IST (UTC+2) -- still
  // standard time. Skips Friday 2026-03-27 (the very day Israel's
  // clocks spring forward to IDT) / Saturday 2026-03-28 and lands on
  // Sunday 2026-03-29, already fully in IDT (UTC+3) by 10:00 local.
  const iso = automaticFollowUpDueAtIso("2026-03-26T10:00:00.000Z");
  assert.equal(iso, "2026-03-29T07:00:00.000Z");
  assert.equal(iso, zonedWallTimeToUtcIso("2026-03-29", "10:00", ISRAEL_TIME_ZONE));
});
