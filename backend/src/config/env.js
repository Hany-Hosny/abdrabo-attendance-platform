import path from "node:path";
import dotenv from "dotenv";

// Prefer a backend-local .env when present, then fall back to the project root .env.
// This keeps workspace scripts and Docker-based development consistent.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

export function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const required = ["DATABASE_URL", "TOKEN_SECRET", "ADMIN_PASSWORD"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  if (process.env.TOKEN_SECRET === "dev_change_this_token_secret" || process.env.TOKEN_SECRET.length < 32) throw new Error("TOKEN_SECRET must be a unique secret of at least 32 characters in production");
  if (process.env.ADMIN_PASSWORD === "change_me_123") throw new Error("ADMIN_PASSWORD must be changed in production");
}
