import { normalizeDigits } from "./normalizeDigits";

const arabicKeyboardToLatin: Record<string, string> = {
  "ض": "q", "ص": "w", "ث": "e", "ق": "r", "ف": "t", "غ": "y", "ع": "u", "ه": "i", "خ": "o", "ح": "p", "ج": "[", "د": "]",
  "ش": "a", "س": "s", "ي": "d", "ب": "f", "ل": "g", "ا": "h", "ت": "j", "ن": "k", "م": "l", "ك": ";", "ط": "'",
  "ئ": "z", "ء": "x", "ؤ": "c", "ر": "v", "ى": "n", "ة": "m", "و": ",", "ز": ".", "ظ": "/"
};

function restoreScannerKeyboardLayout(value: string) {
  return value
    .replace(/\uFEFB|\uFEFC/g, "b")
    .replace(/لا/g, "b")
    .split("")
    .map((character) => arabicKeyboardToLatin[character] || character)
    .join("");
}

export type ScannerState = "idle" | "scanning" | "loading" | "success" | "error";

export function normalizeScanValue(value: unknown) {
  return restoreScannerKeyboardLayout(normalizeDigits(value))
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^\](?:C[0-3]|Q[0-9]|d[0-9])/i, "")
    .trim()
    .toUpperCase();
}

export function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function playScannerFeedback(kind: "success" | "error") {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = kind === "success" ? 880 : 220;
    gain.gain.setValueAtTime(0.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.08);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.08);
    oscillator.addEventListener("ended", () => void context.close());
  } catch (_error) {
    // Audio feedback is optional and must never affect the scan operation.
  }
}
