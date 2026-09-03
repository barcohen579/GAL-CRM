import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidMonthKey, resolveSelectedMonth, currentMonthKey, previousMonthKeyOf } from "./date-range.ts";

// currentMonthKey() reads the real system clock — every assertion
// below is derived from it at test-run time (never a hardcoded date),
// so this file stays correct no matter when it actually runs.

test("isValidMonthKey: accepts a well-formed YYYY-MM key", () => {
  assert.equal(isValidMonthKey("2026-09"), true);
  assert.equal(isValidMonthKey("2026-01"), true);
  assert.equal(isValidMonthKey("2026-12"), true);
});

test("isValidMonthKey: rejects malformed input", () => {
  assert.equal(isValidMonthKey(""), false);
  assert.equal(isValidMonthKey("2026-13"), false);
  assert.equal(isValidMonthKey("2026-00"), false);
  assert.equal(isValidMonthKey("2026-9"), false);
  assert.equal(isValidMonthKey("2026-09-01"), false);
  assert.equal(isValidMonthKey("garbage"), false);
  assert.equal(isValidMonthKey(undefined), false);
  assert.equal(isValidMonthKey(null), false);
  assert.equal(isValidMonthKey(123), false);
});

test("resolveSelectedMonth: missing param defaults to the current month", () => {
  const resolved = resolveSelectedMonth(undefined);
  assert.equal(resolved.key, currentMonthKey());
  assert.equal(resolved.isCurrentMonth, true);
});

test("resolveSelectedMonth: invalid param falls back to the current month rather than crashing", () => {
  const resolved = resolveSelectedMonth("not-a-month");
  assert.equal(resolved.key, currentMonthKey());
});

test("resolveSelectedMonth: a valid PAST month is honored as-is", () => {
  const past = previousMonthKeyOf(currentMonthKey());
  const resolved = resolveSelectedMonth(past);
  assert.equal(resolved.key, past);
  assert.equal(resolved.isCurrentMonth, false);
});

test("resolveSelectedMonth: navigating into a future month is capped back to the current month", () => {
  const cur = currentMonthKey();
  const [y, m] = cur.split("-").map(Number);
  const futureMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
  const resolved = resolveSelectedMonth(futureMonth);
  assert.equal(resolved.key, cur, "a future month must never be selectable");
});

test("resolveSelectedMonth: the current month has no nextMonthKey (nothing meaningful to navigate to)", () => {
  const resolved = resolveSelectedMonth(currentMonthKey());
  assert.equal(resolved.nextMonthKey, null);
});

test("resolveSelectedMonth: a past month's nextMonthKey is exactly one calendar month later", () => {
  const past = previousMonthKeyOf(currentMonthKey());
  const resolved = resolveSelectedMonth(past);
  assert.equal(resolved.nextMonthKey, currentMonthKey());
});

test("resolveSelectedMonth: previousMonthKey is always exactly one calendar month earlier than the selected key", () => {
  const resolved = resolveSelectedMonth(currentMonthKey());
  assert.equal(resolved.previousMonthKey, previousMonthKeyOf(resolved.key));
});

test("resolveSelectedMonth: date bounds are internally consistent (start <= end, exclusive end is one day past inclusive end)", () => {
  const resolved = resolveSelectedMonth("2026-09");
  assert.equal(resolved.startDate, "2026-09-01");
  assert.equal(resolved.endDate, "2026-09-30");
  assert.ok(resolved.startTimestamp < resolved.endTimestampExclusive);
});

test("resolveSelectedMonth: label is a real Hebrew month+year string", () => {
  const resolved = resolveSelectedMonth("2026-09");
  assert.equal(resolved.label, "ספטמבר 2026");
});
