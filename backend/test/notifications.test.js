import test from "node:test";
import assert from "node:assert/strict";
import { recordWhatsAppConnectionNotification } from "../src/services/notifications.js";

test("records WhatsApp disconnect alerts only for active users with WhatsApp view access", async () => {
  const inserts = [];
  const db = async (sql, params = []) => {
    if (sql.startsWith("SELECT id, role, permissions")) {
      return {
        rows: [
          { id: 1, role: "owner", permissions: [] },
          { id: 2, role: "staff", permissions: ["whatsapp.view"] },
          { id: 3, role: "staff", permissions: [] }
        ]
      };
    }
    inserts.push({ sql, params });
    return { rowCount: 1 };
  };

  const result = await recordWhatsAppConnectionNotification({
    reason: "logged_out",
    phoneNumber: "+201012345678",
    db
  });

  assert.equal(result.recorded, 2);
  assert.equal(inserts.length, 2);
  assert.deepEqual(JSON.parse(inserts[0].params[1]), {
    status: "disconnected",
    reason: "logged_out",
    phoneNumber: "+201012345678"
  });
  assert.equal(inserts[0].params[0], 1);
  assert.equal(inserts[1].params[0], 2);
});
