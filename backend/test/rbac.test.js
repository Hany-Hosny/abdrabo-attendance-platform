import test from "node:test";
import assert from "node:assert/strict";
import { canGrantPermissions, hasPermission, normalizePermissions } from "../src/services/rbac.js";

test("Owner automatically has every permission", () => {
  assert.equal(hasPermission({ role: "owner", permissions: [] }, "payments.reverse"), true);
  assert.equal(canGrantPermissions({ role: "owner", permissions: [] }, ["users.delete", "settings.manage"]), true);
});

test("Admin can grant only permissions already assigned to that Admin", () => {
  const actor = { role: "admin", permissions: ["students.view", "students.manage"] };
  assert.equal(canGrantPermissions(actor, ["students.view"]), true);
  assert.equal(canGrantPermissions(actor, ["payments.reverse"]), false);
});

test("Permission normalization removes unknown and duplicate values", () => {
  assert.deepEqual(normalizePermissions(["students.view", "students.view", "not-a-permission"]), ["students.view"]);
});
