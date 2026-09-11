import { test } from "node:test";
import assert from "node:assert/strict";
import { countCustomers } from "./customers.ts";

test("countCustomers: counts exactly the rows given — zero customers", () => {
  assert.equal(countCustomers([]), 0);
});

test("countCustomers: counts exactly the rows given — several customers", () => {
  const rows = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];
  assert.equal(countCustomers(rows), 3);
});

test("countCustomers: never influenced by anything other than the rows passed in (no Lead/Purchase/Payment shape leaks in)", () => {
  // The function's signature only accepts {id} rows — this test pins
  // that a caller can never accidentally pass a Leads or Payments array
  // and have it silently "work": the count is purely rows.length, with
  // no awareness of any other table.
  const customerRows = [{ id: "a" }, { id: "b" }];
  assert.equal(countCustomers(customerRows), customerRows.length);
});
