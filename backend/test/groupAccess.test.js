import test from "node:test";
import assert from "node:assert/strict";
import { appendGroupScope, canAssignGroups, hasGroupAccess, normalizeGroupIds, parseGroupIds } from "../src/services/groupAccess.js";

test("group access normalizes and deduplicates valid identifiers", () => {
  assert.deepEqual(normalizeGroupIds(["3", 1, 3, 2, "invalid", 0]), [1, 2, 3]);
  assert.deepEqual(parseGroupIds(["3", 1, 3]), { ok: true, groupIds: [1, 3] });
  assert.deepEqual(parseGroupIds(["3", "bad"]), { ok: false, status: "invalid_group_ids" });
});

test("owners and admins remain unrestricted while staff is scoped", () => {
  assert.equal(hasGroupAccess({ role: "owner", group_ids: [] }, 99), true);
  assert.equal(hasGroupAccess({ role: "admin", group_ids: [] }, 99), true);
  assert.equal(hasGroupAccess({ role: "staff", group_ids: [2, 4] }, 2), true);
  assert.equal(hasGroupAccess({ role: "staff", group_ids: [2, 4] }, 3), false);
  assert.equal(canAssignGroups({ role: "manager", group_ids: [2, 4] }, [2]), true);
  assert.equal(canAssignGroups({ role: "manager", group_ids: [2, 4] }, [3]), false);
});

test("restricted group scope appends a parameterized SQL predicate", () => {
  const filters = ["s.deleted_at IS NULL"];
  const values = [];
  appendGroupScope(filters, values, { role: "staff", group_ids: [4, 2] }, "s.group_id");
  assert.deepEqual(filters, ["s.deleted_at IS NULL", "s.group_id = ANY($1::int[])"]);
  assert.deepEqual(values, [[2, 4]]);
});
