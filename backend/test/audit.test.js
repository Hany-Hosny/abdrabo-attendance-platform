import test from "node:test";
import assert from "node:assert/strict";
import { auditSafeBody, changedFields } from "../src/services/audit.js";

test("auditSafeBody redacts sensitive values recursively", () => {
  const value = auditSafeBody({ password: "secret", profile: { token: "jwt", name: "Developer" }, amount: 1500 });
  assert.equal(value.password, "[REDACTED]");
  assert.equal(value.profile.token, "[REDACTED]");
  assert.equal(value.amount, 1500);
});

test("changedFields records exact before and after values", () => {
  assert.deepEqual(changedFields({ grade: "Prep 1", phone: "0100" }, { grade: "Prep 2", phone: "0111" }), [
    { field: "grade", before: "Prep 1", after: "Prep 2" },
    { field: "phone", before: "0100", after: "0111" }
  ]);
});
