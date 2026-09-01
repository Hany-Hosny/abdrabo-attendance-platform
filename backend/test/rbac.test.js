import test from "node:test";
import assert from "node:assert/strict";
import { canGrantPermissions, DASHBOARD_PERMISSIONS, DEFAULT_ADMIN_PERMISSIONS, hasPermission, normalizePermissions } from "../src/services/rbac.js";
import { requirePermission } from "../src/middleware/requireTeacher.js";

test("Owner automatically has every permission", () => {
  assert.equal(hasPermission({ role: "owner", permissions: [] }, "payments.reverse"), true);
  assert.equal(canGrantPermissions({ role: "owner", permissions: [] }, ["users.delete", "settings.manage"]), true);
  DASHBOARD_PERMISSIONS.forEach((permission) => assert.equal(hasPermission({ role: "owner", permissions: [] }, permission), true));
});

test("Normal admins do not inherit dashboard permissions from their role", () => {
  assert.equal(hasPermission({ role: "admin", permissions: [] }, "dashboard.view"), false);
  assert.equal(hasPermission({ role: "admin", permissions: [] }, "dashboard.financial.view"), false);
  assert.equal(DEFAULT_ADMIN_PERMISSIONS.includes("dashboard.financial.view"), false);
});

test("Dashboard gateway denies admins without dashboard.view", () => {
  let statusCode = 0;
  let body = null;
  let continued = false;
  const response = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; }
  };
  requirePermission("dashboard.view")(
    { teacher: { role: "admin", permissions: ["dashboard.financial.view"] } },
    response,
    () => { continued = true; }
  );
  assert.equal(statusCode, 403);
  assert.equal(body.permission, "dashboard.view");
  assert.equal(continued, false);
});

test("System settings gateway requires settings.manage for normal admins", () => {
  let statusCode = 0;
  let continued = false;
  const response = {
    status(code) { statusCode = code; return this; },
    json() { return this; }
  };
  requirePermission("settings.manage")(
    { teacher: { role: "admin", permissions: [] } },
    response,
    () => { continued = true; }
  );
  assert.equal(statusCode, 403);
  assert.equal(continued, false);

  statusCode = 0;
  requirePermission("settings.manage")(
    { teacher: { role: "owner", permissions: [] } },
    response,
    () => { continued = true; }
  );
  assert.equal(statusCode, 0);
  assert.equal(continued, true);
});

test("Admin can grant only permissions already assigned to that Admin", () => {
  const actor = { role: "admin", permissions: ["students.view", "students.manage"] };
  assert.equal(canGrantPermissions(actor, ["students.view"]), true);
  assert.equal(canGrantPermissions(actor, ["payments.reverse"]), false);
});

test("Collection-only staff get payment actions without reports or reversal", () => {
  const staff = {
    role: "staff",
    permissions: ["payments.view", "payments.collect", "payments.advance"]
  };
  assert.equal(hasPermission(staff, "payments.view"), true);
  assert.equal(hasPermission(staff, "payments.collect"), true);
  assert.equal(hasPermission(staff, "payments.advance"), true);
  assert.equal(hasPermission(staff, "payments.reports.view"), false);
  assert.equal(hasPermission(staff, "payments.reverse"), false);
});

test("Payment reports remain separate from student-profile access", () => {
  const staff = { role: "staff", permissions: ["students.view", "payments.view", "payments.collect", "payments.advance"] };
  assert.equal(hasPermission(staff, "students.view"), true);
  assert.equal(hasPermission(staff, "payments.view"), true);
  assert.equal(hasPermission(staff, "payments.reports.view"), false);
});

test("Legacy payments.manage remains collection-compatible but never grants reports", () => {
  const legacyAdmin = { role: "admin", permissions: ["payments.view", "payments.manage"] };
  assert.equal(hasPermission(legacyAdmin, "payments.collect"), true);
  assert.equal(hasPermission(legacyAdmin, "payments.advance"), true);
  assert.equal(hasPermission(legacyAdmin, "payments.reports.view"), false);
  assert.equal(DEFAULT_ADMIN_PERMISSIONS.includes("payments.reports.view"), false);
  assert.equal(DEFAULT_ADMIN_PERMISSIONS.includes("payments.collect"), false);
  assert.equal(DEFAULT_ADMIN_PERMISSIONS.includes("payments.advance"), false);
});

test("Payment capabilities enforce view as their gateway", () => {
  const response = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  let continued = false;
  requirePermission("payments.view")(
    { teacher: { role: "staff", permissions: ["payments.collect"] } },
    response,
    () => { continued = true; }
  );
  assert.equal(response.statusCode, 403);
  assert.equal(continued, false);
});

test("Fine-grained payment middleware denies each missing capability", () => {
  const capabilities = [
    "payments.collect",
    "payments.advance",
    "payments.reports.view",
    "payments.reverse"
  ];
  for (const permission of capabilities) {
    const response = {
      statusCode: 0,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; }
    };
    let continued = false;
    requirePermission(permission)(
      { teacher: { role: "staff", permissions: ["payments.view"] } },
      response,
      () => { continued = true; }
    );
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.permission, permission);
    assert.equal(continued, false);
  }
});

test("Permission normalization removes unknown and duplicate values", () => {
  assert.deepEqual(normalizePermissions(["students.view", "students.view", "not-a-permission"]), ["students.view"]);
});
