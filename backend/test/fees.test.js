import test from "node:test";
import assert from "node:assert/strict";
import { paymentRequestMatches } from "../src/services/fees.js";
import { readRequiredPaymentIdempotencyKey } from "../src/utils/paymentIdempotency.js";

function requestWithKey(headerValue, body = {}) {
  return { get: () => headerValue, body };
}

test("payment endpoints require a valid header or backward-compatible body idempotency key", () => {
  assert.deepEqual(readRequiredPaymentIdempotencyKey(requestWithKey(undefined)), { error: "missing_idempotency_key" });
  assert.deepEqual(readRequiredPaymentIdempotencyKey(requestWithKey("bad key")), { error: "invalid_idempotency_key" });
  assert.match(readRequiredPaymentIdempotencyKey(requestWithKey("payment-key-123")).idempotencyKey, /^payment-key-123$/);
  assert.match(readRequiredPaymentIdempotencyKey(requestWithKey(undefined, { idempotency_key: "body-key-123" })).idempotencyKey, /^body-key-123$/);
});

test("payment idempotency compares all normal-payment financial fields", () => {
  const original = {
    student_id: 7,
    payment_type: "normal",
    payment_method: "cash",
    discount_amount: "25.00",
    is_exempt: false
  };
  const base = { studentId: 7, paymentType: "normal", paymentMethod: "cash", discountAmount: 25, isExempt: false };
  assert.equal(paymentRequestMatches(original, base), true);
  assert.equal(paymentRequestMatches(original, { ...base, discountAmount: 10 }), false);
  assert.equal(paymentRequestMatches(original, { ...base, isExempt: true }), false);
  assert.equal(paymentRequestMatches(original, { ...base, studentId: 8 }), false);
  assert.equal(paymentRequestMatches(original, { ...base, paymentMethod: "bank" }), false);
});

test("payment idempotency compares the selected advance months", () => {
  const original = {
    student_id: 7,
    payment_type: "advance",
    payment_method: "cash",
    discount_amount: 0,
    is_exempt: false,
    payment_months: [{ month: "2026-10-01" }, { month: "2026-11-01" }]
  };
  const base = { studentId: 7, paymentType: "advance", paymentMethod: "cash", months: ["2026-11", "2026-10"] };
  assert.equal(paymentRequestMatches(original, base), true);
  assert.equal(paymentRequestMatches(original, { ...base, months: ["2026-10"] }), false);
  assert.equal(paymentRequestMatches(original, { ...base, months: ["2026-10", "2026-12"] }), false);
});
