import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISRAEL_TIME_ZONE,
  zonedWallTimeToUtcIso,
  zonedParts,
  isSameZonedCalendarDay,
  timeZoneOffsetMinutes,
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
