import test from "node:test";
import assert from "node:assert/strict";
import { isValidScanValue, normalizeIdempotencyKey, normalizeScanValue, scanLookupValues } from "../src/utils/scan.js";

test("scanner normalization handles digits, whitespace, invisible characters, suffixes, and Arabic keyboard layout", () => {
  assert.equal(normalizeScanValue("\u200B  ABD-A١٧٢٤-٧٢٦٠٧٨\r\n"), "ABD-A1724-726078");
  assert.equal(normalizeScanValue("]C1A-٢٣٠٣\n"), "A-2303");
  assert.equal(normalizeScanValue("ش-٢٣٠٣"), "A-2303");
  assert.equal(normalizeScanValue(' "ABD-A2303-726078"\r\n'), "ABD-A2303-726078");
});

test("scanner lookup accepts printed-label variants and legacy student codes", () => {
  assert.deepEqual(scanLookupValues("ABD-A2303-726078"), ["ABD-A2303-726078", "ABDA2303726078", "A-2303"]);
  assert.deepEqual(scanLookupValues("A2303"), ["A2303", "A-2303"]);
  assert.deepEqual(scanLookupValues("2303"), ["2303", "A-2303"]);
});

test("scanner input and idempotency keys have bounded safe formats", () => {
  assert.equal(isValidScanValue("A-2303"), true);
  assert.equal(isValidScanValue("A\u00002303"), false);
  assert.equal(isValidScanValue("x".repeat(129)), false);
  assert.equal(normalizeIdempotencyKey("scan-12345678"), "scan-12345678");
  assert.equal(normalizeIdempotencyKey("short"), null);
  assert.equal(normalizeIdempotencyKey("bad key 123456"), null);
});
