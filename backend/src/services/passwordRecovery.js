import crypto from "node:crypto";
import { pool, query } from "../db/pool.js";
import { hashPassword } from "./auth.js";
import { auditLog } from "./audit.js";
import { sendPasswordRecoveryEmail } from "./email.js";
import { getPasswordRecoveryConfig } from "./passwordRecoveryConfig.js";

export const PASSWORD_RESET_TTL_MS = 10 * 60 * 1000;
export const PASSWORD_RESET_RESEND_COOLDOWN_MS = 60 * 1000;
export const PASSWORD_RESET_MAX_ATTEMPTS = 5;
export const PASSWORD_MIN_LENGTH = 8;

export const GENERIC_RESET_MESSAGE = Object.freeze({
  ar: "إذا كان الحساب مسجلاً، سيتم إرسال رمز التحقق إلى البريد الإلكتروني المرتبط به.",
  en: "If the account exists, a verification code will be sent to the associated email address."
});

export const INVALID_CODE_MESSAGE = Object.freeze({
  ar: "رمز التحقق غير صحيح أو انتهت صلاحيته.",
  en: "The verification code is invalid or has expired."
});

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function hashToken(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function safeLanguage(value) {
  return value === "ar" ? "ar" : "en";
}

export function normalizeResetIdentifier(value) {
  return String(value || "").trim().toLowerCase().slice(0, 320);
}

export function normalizeOtp(value) {
  return String(value || "").replace(/[٠-٩۰-۹]/g, (digit) => "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(digit) % 10).replace(/\D/g, "").slice(0, 6);
}

function passwordError(password, confirmation = null) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > 128) return "invalid_password";
  if (confirmation !== null && password !== confirmation) return "password_mismatch";
  return null;
}

function resetEmail(language, code) {
  const arabic = language === "ar";
  return {
    subject: arabic ? "رمز استعادة كلمة المرور" : "Password recovery verification code",
    text: arabic
      ? `Mr. Ahmed Abdrabo System\n\nرمز استعادة كلمة المرور\n\n${code}\n\nالرمز صالح لمدة 10 دقائق.\nإذا لم تطلب تغيير كلمة المرور، يمكنك تجاهل هذه الرسالة.`
      : `Mr. Ahmed Abdrabo System\n\nPassword recovery verification code\n\n${code}\n\nThis code is valid for 10 minutes.\nIf you did not request a password change, you can ignore this email.`,
    html: arabic
      ? `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8"><p style="color:#667085">Mr. Ahmed Abdrabo System</p><h2>رمز استعادة كلمة المرور</h2><p style="font-size:32px;letter-spacing:8px;font-weight:700">${code}</p><p>الرمز صالح لمدة 10 دقائق.</p><p>إذا لم تطلب تغيير كلمة المرور، يمكنك تجاهل هذه الرسالة.</p></div>`
      : `<div style="font-family:Arial,sans-serif;line-height:1.8"><p style="color:#667085">Mr. Ahmed Abdrabo System</p><h2>Password recovery verification code</h2><p style="font-size:32px;letter-spacing:8px;font-weight:700">${code}</p><p>This code is valid for 10 minutes.</p><p>If you did not request a password change, you can ignore this email.</p></div>`
  };
}

export async function requestPasswordReset(identifier, { language = "en", request = null, db = pool, audit = auditLog, sendEmail = sendPasswordRecoveryEmail, getConfig = getPasswordRecoveryConfig } = {}) {
  const normalized = normalizeResetIdentifier(identifier);
  const anonymousFlowId = crypto.randomUUID();
  const config = await getConfig(db === pool ? query : db);
  if (!normalized || !config.enabled) {
    await audit({ action: "password_reset_requested", details: { result: "accepted" }, request });
    return { accepted: true, flowId: anonymousFlowId };
  }

  const execute = typeof db === "function" ? db : db.query.bind(db);
  const client = db === pool ? await db.connect() : null;
  const run = client ? client.query.bind(client) : execute;
  let teacher;
  let flowId = anonymousFlowId;
  let code = "";
  let cooldown = false;
  try {
    if (client) await run("BEGIN");
    const account = await run(
      `SELECT id, email, username
       FROM teachers
       WHERE is_active = TRUE AND deleted_at IS NULL
         AND (LOWER(email) = $1 OR LOWER(username) = $1)
       LIMIT 1
       FOR UPDATE`,
      [normalized]
    );
    teacher = account.rows[0];
    if (teacher && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(teacher.email || ""))) {
      const latest = await run(
        `SELECT id, last_sent_at FROM password_reset_requests
         WHERE user_id = $1 AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [teacher.id]
      );
      cooldown = Boolean(latest.rowCount && Date.now() - new Date(latest.rows[0].last_sent_at).getTime() < PASSWORD_RESET_RESEND_COOLDOWN_MS);
      if (cooldown) flowId = latest.rows[0].id;
      else {
        flowId = crypto.randomUUID();
        code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
        const codeHash = hmac(`${flowId}:${code}`, config.resetSecret);
        await run("UPDATE password_reset_requests SET consumed_at = COALESCE(consumed_at, NOW()), updated_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL", [teacher.id]);
        await run(
          `INSERT INTO password_reset_requests (id, user_id, code_hash, expires_at, last_sent_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [flowId, teacher.id, codeHash, new Date(Date.now() + PASSWORD_RESET_TTL_MS)]
        );
      }
    }
    if (client) await run("COMMIT");
  } catch (error) {
    if (client) await run("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
  if (!teacher || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(teacher.email || ""))) {
    await audit({ action: "password_reset_requested", details: { result: "accepted" }, request });
    return { accepted: true, flowId: anonymousFlowId };
  }
  if (cooldown) {
    await audit({ action: "password_reset_rate_limited", details: { result: "accepted", reason: "cooldown" }, request });
    return { accepted: true, flowId };
  }
  await audit({ action: "password_reset_requested", details: { result: "accepted" }, request });
  try {
    await sendEmail({ provider: config.provider, to: teacher.email, fromEmail: config.fromEmail, senderName: config.senderName, smtpConfig: config.smtp, apiKey: config.apiKey, ...resetEmail(safeLanguage(language), code) });
    await audit({ action: "password_reset_code_sent", details: { result: "accepted", provider: config.provider }, request });
  } catch (_error) {
    await execute("UPDATE password_reset_requests SET consumed_at = NOW(), updated_at = NOW() WHERE id = $1 AND consumed_at IS NULL", [flowId]);
    await audit({ action: "password_reset_code_send_failed", details: { result: "failure", provider: config.provider }, request });
  }
  return { accepted: true, flowId };
}

export async function verifyPasswordResetCode(flowId, otp, { request = null, db = pool, audit = auditLog, getConfig = getPasswordRecoveryConfig } = {}) {
  const config = await getConfig(db === pool ? query : db);
  const normalizedOtp = normalizeOtp(otp);
  const execute = typeof db === "function" ? db : db.query.bind(db);
  if (!crypto.randomUUID || !/^[0-9a-f-]{36}$/i.test(String(flowId || "")) || normalizedOtp.length !== 6 || !config.enabled || !config.resetSecret) return { ok: false, status: "invalid_code" };
  const client = db === pool ? await db.connect() : null;
  const run = client ? client.query.bind(client) : execute;
  try {
    if (client) await run("BEGIN");
    const result = await run(
      `SELECT pr.id, pr.user_id, pr.code_hash, pr.expires_at, pr.verified_at, pr.consumed_at, pr.attempts
       FROM password_reset_requests pr JOIN teachers t ON t.id = pr.user_id
       WHERE pr.id = $1 AND t.is_active = TRUE AND t.deleted_at IS NULL
       FOR UPDATE`,
      [flowId]
    );
    const row = result.rows[0];
    const expired = !row || row.consumed_at || row.verified_at || new Date(row.expires_at).getTime() <= Date.now() || Number(row.attempts) >= PASSWORD_RESET_MAX_ATTEMPTS;
    const candidate = row && !expired ? hmac(`${flowId}:${normalizedOtp}`, config.resetSecret) : "";
    const valid = Boolean(row && !expired && candidate.length === row.code_hash.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(row.code_hash)));
    if (!valid) {
      if (row && !expired) {
        const attempts = Number(row.attempts) + 1;
        await run("UPDATE password_reset_requests SET attempts = $1, consumed_at = CASE WHEN $1 >= $2 THEN NOW() ELSE consumed_at END, updated_at = NOW() WHERE id = $3", [attempts, PASSWORD_RESET_MAX_ATTEMPTS, flowId]);
      }
      await audit({ db: client || execute, action: "password_reset_verification_failed", details: { result: "failure" }, request });
      if (client) await run("COMMIT");
      return { ok: false, status: "invalid_code" };
    }
    const resetToken = crypto.randomBytes(32).toString("base64url");
    await run("UPDATE password_reset_requests SET verified_at = NOW(), reset_token_hash = $1, reset_token_expires_at = $2, updated_at = NOW() WHERE id = $3", [hashToken(resetToken), new Date(Date.now() + PASSWORD_RESET_TTL_MS), flowId]);
    await audit({ db: client || execute, action: "password_reset_verified", details: { result: "success" }, request });
    if (client) await run("COMMIT");
    return { ok: true, resetToken };
  } catch (error) {
    if (client) await run("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

export async function resetPassword(resetToken, password, confirmation, { request = null, db = pool, audit = auditLog } = {}) {
  const validationError = passwordError(password, confirmation);
  if (validationError) return { ok: false, status: validationError };
  const token = String(resetToken || "");
  if (token.length < 32) return { ok: false, status: "invalid_reset_authorization" };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT pr.id, pr.user_id
       FROM password_reset_requests pr JOIN teachers t ON t.id = pr.user_id
       WHERE pr.reset_token_hash = $1 AND pr.verified_at IS NOT NULL
         AND pr.consumed_at IS NULL AND pr.reset_token_expires_at > NOW()
         AND t.is_active = TRUE AND t.deleted_at IS NULL
       FOR UPDATE`,
      [hashToken(token)]
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, status: "invalid_reset_authorization" };
    }
    await client.query("UPDATE teachers SET password_hash = $1, auth_version = auth_version + 1, updated_at = NOW() WHERE id = $2", [hashPassword(password), row.user_id]);
    await client.query("UPDATE password_reset_requests SET consumed_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL", [row.user_id]);
    await audit({ db: client, action: "password_reset_completed", actorId: row.user_id, details: { result: "success" }, request });
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
