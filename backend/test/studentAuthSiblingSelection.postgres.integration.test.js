import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { hashPassword } = await import("../src/services/auth.js");
const {
  consumeGuardianSelectionContext,
  createGuardianSelectionContext,
  findGuardianCandidates,
  loadEligibleStudentForPurpose,
  issuePinToken,
  consumePinTokenAndSetPin
} = await import("../src/services/studentPinAuth.js");

integrationTest("live sibling selection preserves setup/recovery isolation", async () => {
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  const tag = `Sibling QA ${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const guardianPhone = "01012345678";
  const codes = [`A-${Math.floor(1000 + Math.random() * 8999)}`, `A-${Math.floor(1000 + Math.random() * 8999)}`, `A-${Math.floor(1000 + Math.random() * 8999)}`, `A-${Math.floor(1000 + Math.random() * 8999)}`, `A-${Math.floor(1000 + Math.random() * 8999)}`];
  try {
    const center = await db.query("INSERT INTO centers (name, address, latitude, longitude) VALUES ($1, $1, 0, 0) RETURNING id", [tag]);
    const group = await db.query("INSERT INTO groups (center_id, name, grade, subject) VALUES ($1, $2, 'QA', 'QA') RETURNING id", [center.rows[0].id, tag]);
    const students = await db.query(
      `INSERT INTO students (group_id, student_code, student_serial, full_name, guardian_phone, pin_hash, is_active, absence_frozen, deleted_at)
       VALUES
         ($1, $2, $2, $3, $4, NULL, TRUE, FALSE, NULL),
         ($1, $5, $5, $6, $4, NULL, TRUE, FALSE, NULL),
         ($1, $7, $7, $8, $4, $9, TRUE, FALSE, NULL),
         ($1, $10, $10, $11, $4, NULL, FALSE, FALSE, NULL),
         ($1, $12, $12, $13, $4, NULL, TRUE, TRUE, NULL)
       RETURNING id, full_name`,
      [group.rows[0].id, codes[0], `${tag} Ahmed`, guardianPhone, codes[1], `${tag} Salma`, codes[2], `${tag} Recovery`, hashPassword("1234"), codes[3], `${tag} Inactive`, codes[4], `${tag} Frozen`]
    );
    const [setupA, setupB, recoveryStudent] = students.rows;

    const setupCandidates = await findGuardianCandidates("+20 1012345678", "pin_setup");
    assert.deepEqual(setupCandidates.map((student) => student.id).sort((a, b) => a - b), [setupA.id, setupB.id].sort((a, b) => a - b));
    const recoveryCandidates = await findGuardianCandidates("٠١٠١٢٣٤٥٦٧٨", "pin_recovery");
    assert.deepEqual(recoveryCandidates.map((student) => student.id), [recoveryStudent.id]);

    const context = createGuardianSelectionContext({ purpose: "pin_setup", studentIds: setupCandidates.map((student) => student.id) });
    assert.ok(context);
    assert.equal(consumeGuardianSelectionContext({ token: context.token, purpose: "pin_setup", studentId: recoveryStudent.id }), false);
    assert.equal(consumeGuardianSelectionContext({ token: context.token, purpose: "pin_setup", studentId: setupA.id }), true);
    assert.equal(consumeGuardianSelectionContext({ token: context.token, purpose: "pin_setup", studentId: setupB.id }), false);

    const eligibleA = await loadEligibleStudentForPurpose(setupA.id, "pin_setup");
    assert.equal(eligibleA.id, setupA.id);
    const setupToken = await issuePinToken(setupA.id, "pin_setup");
    const setupResult = await consumePinTokenAndSetPin({ token: setupToken.token, purpose: "pin_setup", newPin: "2468" });
    assert.equal(setupResult.ok, true);
    const afterSetup = await db.query("SELECT id, pin_hash, auth_version FROM students WHERE id = ANY($1::int[])", [[setupA.id, setupB.id]]);
    const afterById = new Map(afterSetup.rows.map((row) => [row.id, row]));
    assert.ok(afterById.get(setupA.id).pin_hash);
    assert.equal(afterById.get(setupB.id).pin_hash, null);

    const recoveryToken = await issuePinToken(recoveryStudent.id, "pin_recovery");
    const recoveryResult = await consumePinTokenAndSetPin({ token: recoveryToken.token, purpose: "pin_recovery", newPin: "1357" });
    assert.equal(recoveryResult.ok, true);
    assert.equal((await loadEligibleStudentForPurpose(setupB.id, "pin_setup")).id, setupB.id);
  } finally {
    await db.query("DELETE FROM students WHERE full_name LIKE $1", [`${tag}%`]);
    await db.query("DELETE FROM groups WHERE name = $1", [tag]);
    await db.query("DELETE FROM centers WHERE name = $1", [tag]);
    await db.end();
  }
});
