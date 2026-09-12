import { normalizeIdempotencyKey } from "./scan.js";

export const missingPaymentIdempotencyMessage = "A payment operation key is required. / مطلوب مفتاح فريد لعملية الدفع.";

export function readRequiredPaymentIdempotencyKey(req) {
  const headerValue = req.get("Idempotency-Key");
  const rawValue = headerValue !== undefined ? headerValue : req.body?.idempotency_key;
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return { error: "missing_idempotency_key" };
  }
  const idempotencyKey = normalizeIdempotencyKey(rawValue);
  return idempotencyKey ? { idempotencyKey } : { error: "invalid_idempotency_key" };
}
