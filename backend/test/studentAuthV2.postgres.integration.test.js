import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createStudentToken, verifyStudentToken } from "../src/services/auth.js";
import { authenticatedStudent } from "../src/services/studentAuth.js";
import { guardianMatches, issuePinToken, consumePinTokenAndSetPin, hashPinToken, loadStudentForCode, verifyStudentPin } from "../src/services/studentPinAuth.js";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

integrationTest("student auth v2 migration and security invariants hold in PostgreSQL", async () => {
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  const codeA = `A-${Math.floor(1000 + Math.random() * 8999)}`;
  const codeB = `A-${Math.floor(1000 + Math.random() * 8999)}`;
  try {
    const columns = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'students' AND column_name IN ('pin_hash', 'pin_set_at', 'auth_version')`);
    assert.deepEqual(columns.rows.map((row) => row.column_name).sort(), ["auth_version", "pin_hash", "pin_set_at"]);
    const tokenTable = await db.query("SELECT indexname FROM pg_indexes WHERE tablename = 'student_pin_tokens'");
    assert.ok(tokenTable.rows.some((row) => row.indexname.includes("token")));

    const center = await db.query("INSERT INTO centers (name, address, latitude, longitude) VALUES ('Auth QA', 'Auth QA', 0, 0) RETURNING id");
    const group = await db.query("INSERT INTO groups (center_id, name, grade, subject) VALUES ($1, 'Auth QA', 'QA', 'QA') RETURNING id", [center.rows[0].id]);
    const inserted = await db.query(
      `INSERT INTO students (group_id, student_code, student_serial, full_name, guardian_phone, is_active)
       VALUES ($1, $2, $3, 'Auth QA A', '01012345678', TRUE), ($1, $4, $5, 'Auth QA B', '01012345678', TRUE)
       RETURNING id, student_code, auth_version, pin_hash`,
      [group.rows[0].id, codeA, codeA.replace("-", ""), codeB, codeB.replace("-", "")]
    );
    assert.ok(inserted.rows.every((row) => row.auth_version === 0 && row.pin_hash === null));
    assert.equal(guardianMatches({ guardian_phone: "01012345678" }, "+201012345678"), true);
    assert.equal(guardianMatches({ guardian_phone: "01012345678" }, "٢٠١٠١٢٣٤٥٦٧٨"), true);
    assert.equal(guardianMatches({ guardian_phone: "01012345678" }, "01112345678"), false);

    const student = await loadStudentForCode(codeA);
    const issued = await issuePinToken(student.id, "pin_setup");
    const stored = await db.query("SELECT token_hash, purpose, consumed_at FROM student_pin_tokens WHERE student_id = $1", [student.id]);
    assert.equal(stored.rows[0].token_hash, hashPinToken(issued.token));
    assert.notEqual(stored.rows[0].token_hash, issued.token);
    assert.equal(stored.rows[0].purpose, "pin_setup");

    const completed = await consumePinTokenAndSetPin({ token: issued.token, purpose: "pin_setup", newPin: "0007" });
    assert.equal(completed.ok, true);
    assert.equal(completed.auth_version, 1);
    const after = await loadStudentForCode(codeA);
    assert.equal(after.auth_version, 1);
    assert.equal(verifyStudentPin("0007", after.pin_hash), true);
    assert.equal(after.pin_hash.includes("0007"), false);
    assert.equal((await consumePinTokenAndSetPin({ token: issued.token, purpose: "pin_setup", newPin: "1234" })).ok, false);

    const legacyToken = createStudentToken({ id: student.id });
    const legacyBeforeSetup = await authenticatedStudent({ headers: { authorization: `Bearer ${legacyToken}` } }, async () => ({ rows: [{ id: student.id, group_id: group.rows[0].id, is_active: true, absence_frozen: false, auth_version: 0 }] }));
    assert.equal(legacyBeforeSetup.id, student.id);
    const legacyAfterSetup = await authenticatedStudent({ headers: { authorization: `Bearer ${legacyToken}` } }, async () => ({ rows: [{ id: student.id, group_id: group.rows[0].id, is_active: true, absence_frozen: false, auth_version: 1 }] }));
    assert.equal(legacyAfterSetup, null);
    const currentToken = createStudentToken({ id: student.id, auth_version: 1 });
    const current = await authenticatedStudent({ headers: { authorization: `Bearer ${currentToken}` } }, async () => ({ rows: [{ id: student.id, group_id: group.rows[0].id, is_active: true, absence_frozen: false, auth_version: 1 }] }));
    assert.equal(current.id, student.id);
    const oldToken = verifyStudentToken("not-a-token");
    assert.equal(oldToken, null);
  } finally {
    await db.query("DELETE FROM students WHERE full_name LIKE 'Auth QA %'");
    await db.query("DELETE FROM groups WHERE name = 'Auth QA'");
    await db.query("DELETE FROM centers WHERE name = 'Auth QA'");
    await db.end();
  }
});
