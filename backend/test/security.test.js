import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import express from "express";
import helmet from "helmet";
import { loginRateLimit, resetRequestIpRateLimit } from "../src/routes/teacher.js";
import { clearRateLimitBuckets } from "../src/middleware/rateLimit.js";
import { createStudentToken } from "../src/services/auth.js";
import { authenticatedStudent } from "../src/services/studentAuth.js";
import { requireTeacher } from "../src/middleware/requireTeacher.js";

const TEST_STUDENT_ID = 101;

function createSecurityApp() {
  const app = express();
  app.use(helmet({
    hsts: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    frameguard: { action: "deny" },
    noSniff: true
  }));
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb", strict: true, inflate: false }));
  app.use(express.urlencoded({ extended: false, limit: "100kb", parameterLimit: 100, inflate: false }));

  app.get("/public", (_req, res) => res.json({ ok: true }));

  // These use the same production limiter instances, but keep the handlers
  // database-free so the test remains deterministic and self-contained.
  app.post("/api/teacher/login", loginRateLimit, (_req, res) => res.status(401).json({ ok: false }));
  app.post("/api/teacher/forgot-password", resetRequestIpRateLimit, (_req, res) => res.status(202).json({ ok: true }));

  app.get("/api/teacher/me", requireTeacher, (_req, res) => res.json({ ok: true }));
  app.get("/api/admin/dashboard", requireTeacher, (_req, res) => res.json({ ok: true }));

  app.get("/api/student/:id/attendance", async (req, res, next) => {
    try {
      const student = await authenticatedStudent(req, async (_sql, params) => ({
        rowCount: params[0] === TEST_STUDENT_ID ? 1 : 0,
        rows: params[0] === TEST_STUDENT_ID ? [{ id: TEST_STUDENT_ID, group_id: 7 }] : []
      }));
      if (!student || Number(student.id) !== Number(req.params.id)) {
        return res.status(403).json({ ok: false, status: "forbidden" });
      }
      return res.json({ ok: true, attendance: [] });
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large" || error?.type === "parameters.too.many") {
      return res.status(413).json({ ok: false, status: "payload_too_large" });
    }
    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({ ok: false, status: "invalid_request_body" });
    }
    return res.status(500).json({ ok: false, status: "unexpected_error" });
  });

  return app;
}

function request(app, { method = "GET", path, body, headers = {} }) {
  const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  const requestHeaders = { ...headers };
  if (payload !== null) {
    requestHeaders["content-type"] ??= "application/json";
    requestHeaders["content-length"] = String(Buffer.byteLength(payload));
  }

  const socket = new EventEmitter();
  Object.assign(socket, { remoteAddress: "127.0.0.1", encrypted: false, destroy() {} });
  const req = new Readable({
    read() {
      if (this.bodySent) return;
      this.bodySent = true;
      if (payload !== null) this.push(payload);
      this.push(null);
    }
  });
  Object.assign(req, {
    app,
    method,
    url: path,
    originalUrl: path,
    baseUrl: "",
    path,
    ip: "127.0.0.1",
    headers: requestHeaders,
    httpVersion: "1.1",
    socket,
    connection: socket,
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
    header(name) {
      return this.get(name);
    }
  });
  req.destroy = function destroy() {
    this.destroyed = true;
    return this;
  };

  const response = new EventEmitter();
  Object.setPrototypeOf(response, express.response);
  const responseHeaders = {};
  const responseChunks = [];
  Object.assign(response, {
    app,
    req,
    locals: {},
    statusCode: 200,
    finished: false,
    setHeader(name, value) {
      responseHeaders[String(name).toLowerCase()] = String(value);
    },
    getHeader(name) {
      return responseHeaders[String(name).toLowerCase()];
    },
    removeHeader(name) {
      delete responseHeaders[String(name).toLowerCase()];
    },
    write(chunk) {
      responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      this.finished = true;
      this.emit("finish");
      return this;
    }
  });
  req.res = response;

  return new Promise((resolve, reject) => {
    response.once("finish", () => resolve({
      statusCode: response.statusCode,
      headers: responseHeaders,
      body: Buffer.concat(responseChunks).toString("utf8")
    }));
    response.once("error", reject);
    app.handle(req, response, (error) => error ? reject(error) : response.end());
  });
}

test.afterEach(() => {
  clearRateLimitBuckets();
});

test("rejects JSON payloads larger than 100kb with HTTP 413", async () => {
  const app = createSecurityApp();
  const response = await request(app, {
      method: "POST",
      path: "/api/teacher/login",
      body: { payload: "x".repeat(101 * 1024) }
  });
  assert.equal(response.statusCode, 413);
  assert.match(response.body, /payload_too_large/);
});

test("rate-limits rapid teacher login requests and returns standard headers", async () => {
  const app = createSecurityApp();
  const responses = [];
  for (let index = 0; index < 11; index += 1) {
    responses.push(await request(app, {
      method: "POST",
      path: "/api/teacher/login",
      body: { identifier: "teacher@example.com", password: "invalid" }
    }));
  }
  const limited = responses.filter((response) => response.statusCode === 429);
  assert.equal(limited.length, 1);
  assert.ok(limited[0].headers.ratelimit);
  assert.ok(limited[0].headers["ratelimit-policy"]);
  assert.equal(limited[0].headers["retry-after"], "60");
});

test("rate-limits password-recovery requests and returns HTTP 429", async () => {
  const app = createSecurityApp();
  const responses = [];
  for (let index = 0; index < 9; index += 1) {
    responses.push(await request(app, {
      method: "POST",
      path: "/api/teacher/forgot-password",
      body: { identifier: "teacher@example.com" }
    }));
  }
  const limited = responses.filter((response) => response.statusCode === 429);
  assert.equal(limited.length, 1);
  assert.ok(limited[0].headers.ratelimit);
  assert.ok(limited[0].headers["ratelimit-policy"]);
});

test("rejects a student token when it targets another student resource", async () => {
  const token = createStudentToken({ id: TEST_STUDENT_ID });
  const response = await request(createSecurityApp(), {
    path: "/api/student/202/attendance",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(response.statusCode, 403);
});

test("allows a student token to access only its own resource", async () => {
  const token = createStudentToken({ id: TEST_STUDENT_ID });
  const response = await request(createSecurityApp(), {
    path: `/api/student/${TEST_STUDENT_ID}/attendance`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(response.statusCode, 200);
});

test("rejects unauthenticated teacher and admin requests", async () => {
  const app = createSecurityApp();
  for (const path of ["/api/teacher/me", "/api/admin/dashboard"]) {
    const response = await request(app, { path, headers: { authorization: "Bearer invalid-token" } });
    assert.equal(response.statusCode, 401, path);
  }
});

test("sets Helmet security headers on public responses", async () => {
  const response = await request(createSecurityApp(), { path: "/public" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
});
