const digitMap = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9"
};

export function normalizeDigits(value) {
  return String(value ?? "").replace(/[٠-٩۰-۹]/g, (digit) => digitMap[digit] || digit);
}

export function normalizeDigitsTrimmed(value) {
  return normalizeDigits(value).trim();
}

export function normalizeStudentCode(value) {
  return normalizeDigitsTrimmed(value).toUpperCase().replace(/^A(\d{4})$/, "A-$1");
}

export function isPhoneNumber(value) {
  return /^\d{11}$/.test(normalizeDigitsTrimmed(value));
}

export function isNationalId(value) {
  return /^\d{14}$/.test(normalizeDigitsTrimmed(value));
}
