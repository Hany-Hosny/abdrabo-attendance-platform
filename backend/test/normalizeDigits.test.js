import test from "node:test";
import assert from "node:assert/strict";
import { isNationalId, isPhoneNumber, normalizeDigits } from "../src/utils/normalizeDigits.js";

test("normalizes ASCII digits without changing them", () => {
  assert.equal(normalizeDigits("A-2303 / 0123456789"), "A-2303 / 0123456789");
});

test("normalizes Arabic-Indic digits", () => {
  assert.equal(normalizeDigits("A-٢٣٠٣ / ٠١٢٣٤٥٦٧٨٩"), "A-2303 / 0123456789");
});

test("normalizes Persian digits", () => {
  assert.equal(normalizeDigits("A-۲۳۰۳ / ۰۱۲۳۴۵۶۷۸۹"), "A-2303 / 0123456789");
});

test("validates normalized phone and national ID lengths", () => {
  assert.equal(isPhoneNumber("٠١٢٣٤٥٦٧٨٩٠"), true);
  assert.equal(isPhoneNumber("۰۱۲۳۴۵۶۷۸۹۰"), true);
  assert.equal(isNationalId("١٢٣٤٥٦٧٨٩٠١٢٣٤"), true);
  assert.equal(isNationalId("۱۲۳۴۵۶۷۸۹۰۱۲۳۴"), true);
  assert.equal(isPhoneNumber("0123456789"), false);
  assert.equal(isNationalId("01234567890123"), true);
});
