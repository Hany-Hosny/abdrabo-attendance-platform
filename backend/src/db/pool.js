import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://abdrabo:abdrabo_password@localhost:5432/abdrabo_attendance"
});

export async function query(text, params) {
  return pool.query(text, params);
}
