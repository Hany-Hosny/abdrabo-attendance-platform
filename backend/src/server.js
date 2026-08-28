import "dotenv/config";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { studentRouter } from "./routes/student.js";
import { teacherRouter } from "./routes/teacher.js";
import { adminSiteRouter, siteRouter } from "./routes/site.js";
import { adminUsersRouter } from "./routes/adminUsers.js";
import { adminAcademicRouter } from "./routes/adminAcademic.js";
import { operationsRouter } from "./routes/operations.js";
import { inboxRouter, staffInboxRouter } from "./routes/inbox.js";
import { ensureMonthlyFees } from "./services/fees.js";
import { purgeDeletedStudents } from "./services/studentCleanup.js";

const app = express();
const port = Number(process.env.PORT || 4000);

if (process.env.TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.TRUST_PROXY));
}

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || ["http://localhost:3000"],
    credentials: false
  })
);
app.use(express.json({ limit: "100kb" }));

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
app.use("/api/admin", adminAcademicRouter);
app.use("/api", operationsRouter);
app.use("/api/admin", operationsRouter);
app.use("/api/admin", staffInboxRouter);

app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Not found", path: req.path });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ ok: false, message: "Unexpected server error." });
});

migrate()
  .then(() => {
    ensureMonthlyFees().catch((error) => console.error("Failed to create monthly fees", error));
    purgeDeletedStudents().catch((error) => console.error("Failed to purge deleted students", error));
    setInterval(() => ensureMonthlyFees().catch((error) => console.error("Failed to renew monthly fees", error)), 60 * 60 * 1000);
    setInterval(() => purgeDeletedStudents().catch((error) => console.error("Failed to purge deleted students", error)), 24 * 60 * 60 * 1000);
    app.listen(port, () => {
      console.log(`Abdrabo API listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to migrate database", error);
    process.exit(1);
  });
