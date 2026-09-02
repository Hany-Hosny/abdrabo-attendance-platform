import { normalizeDigits } from "./normalizeDigits.js";

const controlCharacters = /[\u0000-\u001F\u007F]/;
const controlCharacterPattern = /[\u0000-\u001F\u007F]/g;
const scannerSuffix = /^\](?:C[0-3]|Q[0-9]|d[0-9])/i;
const arabicKeyboardToLatin = {
  ض: "q", ص: "w", ث: "e", ق: "r", ف: "t", غ: "y", ع: "u", ه: "i", خ: "o", ح: "p", ج: "[", د: "]",
  ش: "a", س: "s", ي: "d", ب: "f", ل: "g", ا: "h", ت: "j", ن: "k", م: "l", ك: ";", ط: "'",
  ئ: "z", ء: "x", ؤ: "c", ر: "v", ى: "n", ة: "m", و: ",", ز: ".", ظ: "/"
};

function restoreScannerKeyboardLayout(value) {
  return value
    .replace(/\uFEFB|\uFEFC/g, "b")
    .replace(/لا/g, "b")
    .split("")
    .map((character) => arabicKeyboardToLatin[character] || character)
    .join("");
}

export function normalizeScanValue(value) {
  return restoreScannerKeyboardLayout(normalizeDigits(String(value ?? "")))
    .replace(controlCharacterPattern, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\uFEFB|\uFEFC/g, "b")
    .replace(/\u0644\u0627/g, "b")
    .trim()
    .replace(scannerSuffix, "")
    .replace(/^[\"'`([{]+|[\"'`)}\]]+$/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}

export function scanLookupValues(value) {
  const normalized = normalizeScanValue(value);
  if (!normalized) return [];

  const values = new Set([normalized]);
  const compact = normalized.replace(/-/g, "");
  values.add(compact);

  if (/^A\d{4}$/.test(normalized)) values.add(`A-${normalized.slice(1)}`);
  if (/^A-\d{4}$/.test(normalized)) values.add(normalized.replace("-", ""));
  if (/^\d{4}$/.test(normalized)) values.add(`A-${normalized}`);

  const labelMatch = compact.match(/^ABDA(\d{4})(?:\d{6})?$/);
  if (labelMatch) values.add(`A-${labelMatch[1]}`);
  if (/^ABD-A\d{4}-\d{6}$/.test(normalized)) values.add(normalized.replace(/^ABD-A(\d{4})-\d{6}$/, "A-$1"));

  return [...values].filter((candidate) => isValidScanValue(candidate));
}

export function isValidScanValue(value) {
  return typeof value === "string" && value.length >= 2 && value.length <= 128 && !controlCharacters.test(value);
}

export function normalizeIdempotencyKey(value) {
  const normalized = String(value ?? "").trim();
  return normalized.length >= 8 && normalized.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(normalized) ? normalized : null;
}
