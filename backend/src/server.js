import { assertProductionConfig } from "./config/env.js";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { migrate } from "./db/migrate.js";
import { pool, query } from "./db/pool.js";
import { studentRouter } from "./routes/student.js";
import { teacherRouter } from "./routes/teacher.js";
import { adminSiteRouter, siteRouter } from "./routes/site.js";
import { adminUsersRouter } from "./routes/adminUsers.js";
import { adminAcademicRouter } from "./routes/adminAcademic.js";
import { adminDashboardRouter } from "./routes/adminDashboard.js";
import { adminSettingsRouter } from "./routes/adminSettings.js";
import { adminSearchRouter } from "./routes/adminSearch.js";
import { adminNotificationsRouter } from "./routes/adminNotifications.js";
import { operationsRouter } from "./routes/operations.js";
import { inboxRouter, staffInboxRouter } from "./routes/inbox.js";
import { ensureMonthlyFees } from "./services/fees.js";
import { finalizeExpiredAttendanceSessions } from "./services/attendanceFinalizer.js";
import { purgeDeletedStudents } from "./services/studentCleanup.js";
import { installAuditFallback } from "./services/audit.js";

const app = express();
const port = Number(process.env.PORT || 4000);
assertProductionConfig();
app.disable("x-powered-by");

if (process.env.TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.TRUST_PROXY));
}

app.use(helmet({
  hsts: process.env.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  frameguard: { action: "deny" },
  noSniff: true
}));

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const isLocalNetwork = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin);
    if (isLocalNetwork || allowedOrigins.includes(origin) || process.env.NODE_ENV !== "production") {
      return callback(null, true);
    }
    return callback(new Error("cors_origin_not_allowed"));
  },
  credentials: false
}));

app.use(express.json({ limit: "100kb" }));

installAuditFallback(app);

app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "abdrabo-attendance-api" });
  } catch (error) {
    next(error);
  }
});

app.use("/api/student", studentRouter);
app.use("/api", inboxRouter);
app.use("/api/teacher", teacherRouter);
app.use("/api/site", siteRouter);
app.use("/api/admin/site", adminSiteRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/admin/dashboard", adminDashboardRouter);
app.use("/api/admin/settings", adminSettingsRouter);
app.use("/api/admin/search", adminSearchRouter);
app.use("/api/admin/notifications", adminNotificationsRouter);
app.use("/api/admin", adminAcademicRouter);
app.use("/api", operationsRouter);
app.use("/api/admin", operationsRouter);
app.use("/api/admin", staffInboxRouter);

app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Not found", path: req.path });
});

app.use((error, _req, res, _next) => {
  if (error?.message === "cors_origin_not_allowed") {
    return res.status(403).json({ ok: false, status: "cors_origin_not_allowed" });
  }
  console.error(error);
  res.status(500).json({ ok: false, message: "Unexpected server error." });
});

migrate()
  .then(() => {
    ensureMonthlyFees().catch((error) => console.error("Failed to create monthly fees", error));
    finalizeExpiredAttendanceSessions().catch((error) => console.error("Failed to finalize expired attendance sessions", error));
    purgeDeletedStudents().catch((error) => console.error("Failed to purge deleted students", error));
    setInterval(() => ensureMonthlyFees().catch((error) => console.error("Failed to renew monthly fees", error)), 60 * 60 * 1000);
    setInterval(() => finalizeExpiredAttendanceSessions().catch((error) => console.error("Failed to finalize expired attendance sessions", error)), 60 * 1000);
    setInterval(() => purgeDeletedStudents().catch((error) => console.error("Failed to purge deleted students", error)), 24 * 60 * 60 * 1000);
    app.listen(port, "0.0.0.0", () => {
      console.log(`Abdrabo API listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to migrate database", error);
    process.exit(1);
  });
