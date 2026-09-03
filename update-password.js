import { pool } from "./backend/src/db/pool.js";
import { hashPassword } from "./backend/src/services/auth.js";

const username = String(process.env.ADMIN_USERNAME || "admin").trim();
const password = String(process.env.ADMIN_PASSWORD || "");

if (!password) {
  throw new Error("Set ADMIN_PASSWORD in the environment before running this utility.");
}

try {
  const result = await pool.query(
    "UPDATE teachers SET password_hash = $1 WHERE username = $2 RETURNING username",
    [hashPassword(password), username]
  );
  console.log(`Updated rows: ${result.rowCount}`);
} catch (error) {
  console.error("Password update failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
