import { test } from "node:test";
import assert from "node:assert/strict";
import { firstOfMonth, addCalendarMonths } from "./recurring.ts";

test("firstOfMonth: normalizes a mid-month date to that month's 1st", () => {
  assert.equal(firstOfMonth("2026-09-17"), "2026-09-01");
});

test("firstOfMonth: a date already on the 1st is unchanged", () => {
  assert.equal(firstOfMonth("2026-09-01"), "2026-09-01");
});

test("firstOfMonth: works on a longer ISO timestamp string too", () => {
  assert.equal(firstOfMonth("2026-09-17T14:30:00.000Z"), "2026-09-01");
});

test("addCalendarMonths: adds within the same year", () => {
  assert.equal(addCalendarMonths("2026-09-01", 1), "2026-10-01");
});

test("addCalendarMonths: rolls over December -> January of next year", () => {
  assert.equal(addCalendarMonths("2026-12-01", 1), "2027-01-01");
});

test("addCalendarMonths: rolls over across multiple years", () => {
  assert.equal(addCalendarMonths("2026-09-01", 16), "2028-01-01");
});

test("addCalendarMonths: negative months move backward within the same year", () => {
  assert.equal(addCalendarMonths("2026-09-01", -1), "2026-08-01");
});

test("addCalendarMonths: negative months roll backward across a year boundary", () => {
  assert.equal(addCalendarMonths("2026-01-01", -1), "2025-12-01");
});

test("addCalendarMonths: zero months is a no-op (still normalized to the 1st)", () => {
  assert.equal(addCalendarMonths("2026-09-17", 0), "2026-09-01");
});

test("addCalendarMonths: always normalizes input to first-of-month regardless of the day given", () => {
  assert.equal(addCalendarMonths("2026-01-31", 1), "2026-02-01");
});
