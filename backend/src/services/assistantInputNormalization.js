const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function replaceDigits(value) {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = ARABIC_DIGITS.indexOf(digit);
    if (arabicIndex >= 0) return String(arabicIndex);
    return String(PERSIAN_DIGITS.indexOf(digit));
  });
}

export function normalizeArabicText(value) {
  return replaceDigits(String(value || "")
    .normalize("NFKC")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[ـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[؟?!،؛:()[\]{}<>"'`]/g, " "))
}

// Matching normalization is intentionally separate from input normalization.
// It is only used for entity lookup, never for stored names or free-form output.
export function normalizeForMatching(value) {
  return replaceDigits(
    String(value || "")
      .normalize("NFKC")
      .replace(ARABIC_DIACRITICS, "")
      .replace(/[ـ]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .toLowerCase()
  )
    .replace(/[ة]/g, "ه")
    .replace(/[ى]/g, "ي")
    .replace(/[؟?!،؛:()[\]{}<>"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LEXICON = [
  ["ordinal", /(?:اول|اولى|اولي|اولى)/, 1],
  ["ordinal", /(?:تاني|تانيه|تانية|ثاني|ثانيه|ثانية)/, 2],
  ["ordinal", /(?:تالت|تالته|تالتة|ثالث|ثالثه|ثالثة)/, 3],
  ["when", /(?:امتى|متي|متى)/],
  ["schedule", /(?:ميعاد|مواعيد|جدول)/],
  ["center", /(?:سنتر|مركز)/],
  ["request", /(?:عايز|عاوز|عايزة|محتاج|محتاجة)/],
  ["amount", /(?:كام|بكام)/]
];

export function collectDialectSignals(normalizedText) {
  return LEXICON.flatMap(([type, pattern, value]) => pattern.test(normalizedText) ? [{ type, ...(value ? { value } : {}) }] : []);
}

export function normalizeAssistantInput(rawText) {
  const raw = String(rawText || "");
  const normalizedText = normalizeArabicText(raw)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return { rawText: raw, normalizedText, dialectSignals: collectDialectSignals(normalizedText) };
}
