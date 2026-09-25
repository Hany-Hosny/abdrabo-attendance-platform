import { normalizeDigits } from "./normalizeDigits.js";

export function normalizeEgyptianPhone(value) {
  let digits = normalizeDigits(value).replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `20${digits.slice(1)}`;
  if (digits.startsWith("1") && digits.length === 10) digits = `20${digits}`;
  if (!/^20(?:10|11|12|15)\d{8}$/.test(digits)) return null;
  return `+${digits}`;
}
