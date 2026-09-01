import { normalizeDigits } from "./normalizeDigits.js";

const controlCharacters = /[\u0000-\u001F\u007F]/;
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
    .replace(controlCharacters, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\uFEFB|\uFEFC/g, "b")
    .replace(/\u0644\u0627/g, "b")
    .trim()
    .replace(scannerSuffix, "")
    .trim()
    .toUpperCase();
}

export function isValidScanValue(value) {
  return typeof value === "string" && value.length >= 2 && value.length <= 128 && !controlCharacters.test(value);
}

export function normalizeIdempotencyKey(value) {
  const normalized = String(value ?? "").trim();
  return normalized.length >= 8 && normalized.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(normalized) ? normalized : null;
}
