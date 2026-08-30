import crypto from "node:crypto";
import "../config/env.js";

const tokenSecret = process.env.TOKEN_SECRET || "dev_change_this_token_secret";

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  const [scheme, salt, originalHash] = String(storedHash || "").split(":");
  if (scheme !== "scrypt" || !salt || !originalHash) return false;

  const candidate = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(originalHash, "hex");
  return original.length === candidate.length && crypto.timingSafeEqual(original, candidate);
}

function base64UrlEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signToken(unsignedToken) {
  return crypto.createHmac("sha256", tokenSecret).update(unsignedToken).digest("base64url");
}

export function createTeacherToken(teacher) {
  const header = base64UrlEncode({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlEncode({
    sub: teacher.id,
    role: teacher.role,
    name: teacher.name,
    email: teacher.email,
    username: teacher.username,
    exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60
  });
  const unsignedToken = `${header}.${payload}`;
  return `${unsignedToken}.${signToken(unsignedToken)}`;
}

export function verifyTeacherToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  const unsignedToken = `${header}.${payload}`;
  const expected = signToken(unsignedToken);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    return null;
  }

  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

export function createAuditAccessToken(adminId) {
  const payload = base64UrlEncode({
    sub: Number(adminId),
    scope: "audit:read",
    exp: Math.floor(Date.now() / 1000) + 10 * 60
  });
  const unsignedToken = `audit.${payload}`;
  return `${unsignedToken}.${crypto.createHmac("sha256", tokenSecret).update(unsignedToken).digest("base64url")}`;
}

export function verifyAuditAccessToken(token, adminId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "audit") return false;
  const unsignedToken = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", tokenSecret).update(unsignedToken).digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(parts[2]);
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.scope === "audit:read" && Number(payload.sub) === Number(adminId) && Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch (_error) {
    return false;
  }
}
