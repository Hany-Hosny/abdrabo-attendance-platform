import path from "node:path";
import dotenv from "dotenv";

// Prefer a backend-local .env when present, then fall back to the project root .env.
// This keeps workspace scripts and Docker-based development consistent.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
