import pg from "pg";

const { Pool } = pg;

function boundedNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://abdrabo:abdrabo_password@localhost:5432/abdrabo_attendance",
  max: boundedNumber("PG_POOL_MAX", 20, 4, 100),
  idleTimeoutMillis: boundedNumber("PG_IDLE_TIMEOUT_MS", 30_000, 1_000, 300_000),
  connectionTimeoutMillis: boundedNumber("PG_CONNECTION_TIMEOUT_MS", 5_000, 500, 30_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: boundedNumber("PG_KEEPALIVE_INITIAL_DELAY_MS", 10_000, 1_000, 60_000)
});

export async function query(text, params) {
  return pool.query(text, params);
}
