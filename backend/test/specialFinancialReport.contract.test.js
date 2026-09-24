import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/routes/operations.js", import.meta.url), "utf8");
const route = source.slice(source.indexOf('operationsRouter.get("/reports/special-financial"'), source.indexOf('operationsRouter.post("/fees/payments/:paymentId/reverse"'));

test("special-financial report is an authenticated, scoped read-only payment-history report", () => {
  assert.match(route, /requirePermission\("payments\.view"\), requirePermission\("payments\.reports\.view"\)/);
  assert.match(route, /p\.is_exempt = TRUE OR p\.discount_amount > 0/);
  assert.match(route, /appendGroupScope\(filters, values, req\.teacher, "p\.group_id"\)/);
  assert.doesNotMatch(route, /INSERT|UPDATE|DELETE/);
});

test("special-financial report defaults reversed settlements out and exposes explicit reversal states", () => {
  assert.match(route, /if \(reversal === "reversed"\) filters\.push\("pr\.id IS NOT NULL"\)/);
  assert.match(route, /filters\.push\("pr\.id IS NULL"\)/);
  assert.match(route, /AND pr\.id IS NULL/);
});

test("special-financial report retains canonical historical search, month, date, pagination, and export contracts", () => {
  assert.match(route, /s\.national_id_hash/);
  assert.doesNotMatch(route, /national_id[^_h]/);
  assert.match(route, /jsonb_array_elements\(CASE WHEN jsonb_typeof\(p\.payment_months\) = 'array'/);
  assert.match(route, /AT TIME ZONE 'Africa\/Cairo'/);
  assert.match(route, /exportMode \? 50_000/);
  assert.match(route, /const offset = exportMode \? 0/);
  assert.match(route, /LIMIT \$\$\{values\.length \+ 1\} OFFSET \$\$\{values\.length \+ 2\}/);
});
