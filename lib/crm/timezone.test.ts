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
