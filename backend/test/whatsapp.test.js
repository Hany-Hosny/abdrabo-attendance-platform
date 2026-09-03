import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEgyptianPhone, validateWhatsAppSettings } from "../src/services/whatsapp.js";
import { hasPermission } from "../src/services/rbac.js";

test("normalizes common Egyptian guardian phone formats", () => {
  assert.equal(normalizeEgyptianPhone("01012345678"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("+20 1012345678"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("٠١٠١٢٣٤٥٦٧٨"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("012345"), null);
});

test("accepts only three or four templates and a 4–8 second delay range", () => {
  const valid = validateWhatsAppSettings({
    auto_send: true,
    templates: ["Template one", "Template two", "Template three"],
    min_delay_seconds: 4,
    max_delay_seconds: 8
  });
  assert.equal(valid.max_delay_seconds, 8);
  assert.throws(() => validateWhatsAppSettings({ ...valid, templates: ["one", "two"] }));
  assert.throws(() => validateWhatsAppSettings({ ...valid, min_delay_seconds: 3 }));
});

test("WhatsApp access can be assigned independently while management includes viewing", () => {
  assert.equal(hasPermission({ role: "staff", permissions: ["whatsapp.view"] }, "whatsapp.view"), true);
  assert.equal(hasPermission({ role: "staff", permissions: ["whatsapp.view"] }, "whatsapp.manage"), false);
  assert.equal(hasPermission({ role: "staff", permissions: ["whatsapp.manage"] }, "whatsapp.view"), true);
});
