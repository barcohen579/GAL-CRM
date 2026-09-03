import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLeadFields } from "./field-data.ts";

test("extractLeadFields: reads standard Meta field keys", () => {
  const result = extractLeadFields([
    { name: "full_name", values: ["Test Person"] },
    { name: "email", values: ["test@example.com"] },
    { name: "phone_number", values: ["0501234567"] },
  ]);
  assert.deepEqual(result, {
    fullName: "Test Person",
    firstName: null,
    lastName: null,
    phone: "0501234567",
    email: "test@example.com",
  });
});

test("extractLeadFields: builds full_name from first_name + last_name when full_name is absent", () => {
  const result = extractLeadFields([
    { name: "first_name", values: ["Test"] },
    { name: "last_name", values: ["Person"] },
  ]);
  assert.equal(result.fullName, "Test Person");
});

test("extractLeadFields: field name matching is case-insensitive", () => {
  const result = extractLeadFields([{ name: "Email", values: ["Test@Example.com"] }]);
  assert.equal(result.email, "Test@Example.com");
});

test("extractLeadFields: never guesses an unrelated custom question as a known field", () => {
  const result = extractLeadFields([
    { name: "how_did_you_hear_about_us", values: ["Instagram"] },
  ]);
  assert.deepEqual(result, {
    fullName: null,
    firstName: null,
    lastName: null,
    phone: null,
    email: null,
  });
});

test("extractLeadFields: handles missing/empty field_data safely", () => {
  assert.deepEqual(extractLeadFields(null), {
    fullName: null,
    firstName: null,
    lastName: null,
    phone: null,
    email: null,
  });
  assert.deepEqual(extractLeadFields([]), {
    fullName: null,
    firstName: null,
    lastName: null,
    phone: null,
    email: null,
  });
});
