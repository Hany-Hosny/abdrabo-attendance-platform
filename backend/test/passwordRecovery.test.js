import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  GENERIC_RESET_MESSAGE,
  INVALID_CODE_MESSAGE,
  normalizeOtp,
  normalizeResetIdentifier,
  PasswordRecoveryUnavailableError,
  requestPasswordReset,
  verifyPasswordResetCode
} from "../src/services/passwordRecovery.js";
import { createTeacherToken, verifyTeacherToken } from "../src/services/auth.js";
import { encryptSecret, decryptSecret, hasEncryptionKey } from "../src/services/secretStorage.js";
import { getPasswordRecoveryConfig, safePasswordRecoveryConfig } from "../src/services/passwordRecoveryConfig.js";
import { EMAIL_PROVIDERS, createGmailTransporter, emailProviderStatus, parseSmtpSecure, readGmailSmtpConfig, sendPasswordRecoveryEmail, sendTransactionalEmail } from "../src/services/email.js";

test("password recovery normalizes identifiers and Arabic-Indic OTP digits", () => {
  assert.equal(normalizeResetIdentifier("  STAFF@Example.COM "), "staff@example.com");
  assert.equal(normalizeOtp("٤٨٢١٩٣"), "482193");
  assert.equal(normalizeOtp("۴۸۲۱۹۳"), "482193");
});

test("reset request returns the same generic contract and never persists the OTP plaintext", async () => {
  const config = { enabled: true, resetSecret: "a".repeat(64), fromEmail: "no-reply@example.com", apiKey: "re_test", provider: "resend" };
  const queries = [];
  let inserted = null;
  let sent = null;
  const db = async (text, params = []) => {
    queries.push({ text, params });
    if (text.includes("SELECT id, email, username")) return { rowCount: 1, rows: [{ id: 7, email: "staff@example.com", username: "staff" }] };
    if (text.includes("SELECT id, last_sent_at")) return { rowCount: 0, rows: [] };
    if (text.startsWith("UPDATE password_reset_requests")) return { rowCount: 0, rows: [] };
    if (text.startsWith("INSERT INTO password_reset_requests")) { inserted = params; return { rowCount: 1, rows: [] }; }
    return { rowCount: 1, rows: [] };
  };
  const audit = async (entry) => { queries.push({ audit: entry }); };
  const result = await requestPasswordReset("staff", {
    db,
    audit,
    getConfig: async () => config,
    sendEmail: async (email) => { sent = email; }
  });
  assert.equal(result.accepted, true);
  assert.match(result.flowId, /^[0-9a-f-]{36}$/i);
  assert.equal(sent.to, "staff@example.com");
  assert.equal(sent.text.includes(sent.to), false);
  assert.equal(inserted[2].length, 64);
  assert.equal(inserted[2].includes(sent.text), false);
  assert.equal(JSON.stringify(queries).includes(sent.text), false);
  assert.deepEqual(GENERIC_RESET_MESSAGE.en, "If the account exists, a verification code will be sent to the associated email address.");
});

test("unavailable recovery does not return a fake OTP flow", async () => {
  let auditEntry = null;
  await assert.rejects(
    () => requestPasswordReset("staff", {
      db: async () => ({ rowCount: 0, rows: [] }),
      getConfig: async () => ({ enabled: false }),
      audit: async (entry) => { auditEntry = entry; }
    }),
    (error) => error instanceof PasswordRecoveryUnavailableError && error.code === "password_recovery_unavailable"
  );
  assert.equal(auditEntry.details.result, "unavailable");
});

test("correct OTP creates a reset authorization and a wrong OTP is generic", async () => {
  const secret = "b".repeat(64);
  const flowId = "11111111-1111-4111-8111-111111111111";
  const code = "482193";
  const hash = crypto.createHmac("sha256", secret).update(`${flowId}:${code}`).digest("hex");
  const row = { id: flowId, user_id: 7, code_hash: hash, expires_at: new Date(Date.now() + 60_000), verified_at: null, consumed_at: null, attempts: 0 };
  const updates = [];
  const db = async (text, params = []) => {
    if (text.includes("SELECT pr.id")) return { rowCount: 1, rows: [{ ...row }] };
    if (text.startsWith("UPDATE password_reset_requests")) { updates.push({ text, params }); return { rowCount: 1, rows: [] }; }
    return { rowCount: 1, rows: [] };
  };
  const config = { enabled: true, resetSecret: secret };
  const audit = async () => undefined;
  const valid = await verifyPasswordResetCode(flowId, "٤٨٢١٩٣", { db, audit, getConfig: async () => config });
  assert.equal(valid.ok, true);
  assert.match(valid.resetToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(updates.length, 1);

  const invalid = await verifyPasswordResetCode(flowId, "000000", { db, audit, getConfig: async () => config });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, "invalid_code");
  assert.equal(INVALID_CODE_MESSAGE.ar, "رمز التحقق غير صحيح أو انتهت صلاحيته.");
});

test("password reset secret storage is authenticated and never plaintext", () => {
  const previous = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = "c".repeat(64);
  try {
    const encrypted = encryptSecret("private-api-key");
    assert.notEqual(encrypted.encryptedValue, "private-api-key");
    assert.equal(decryptSecret({ encrypted_value: encrypted.encryptedValue, iv: encrypted.iv, auth_tag: encrypted.authTag }), "private-api-key");
    assert.equal(hasEncryptionKey(), true);
  } finally {
    if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previous;
  }
});

test("teacher tokens carry the password version for post-reset invalidation", () => {
  const token = createTeacherToken({ id: 7, name: "Staff", email: "staff@example.com", username: "staff", role: "staff", permissions: [], auth_version: 3 });
  assert.equal(verifyTeacherToken(token).auth_version, 3);
});

test("safe recovery configuration omits backend secrets", () => {
  const safe = safePasswordRecoveryConfig({
    enabled: true,
    requestedEnabled: true,
    provider: "resend",
    fromEmail: "no-reply@example.com",
    apiKey: "re_private",
    resetSecret: "secret",
    apiKeyConfigured: true,
    resetSecretConfigured: true,
    encryptionConfigured: true,
    configured: true
  });
  assert.equal(Object.prototype.hasOwnProperty.call(safe, "apiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(safe, "resetSecret"), false);
  assert.equal(safe.apiKeyConfigured, true);
});

test("email provider uses an injectable transport and sanitizes provider failures", async () => {
  let request = null;
  await sendTransactionalEmail({
    to: "owner@example.com",
    from: "no-reply@example.com",
    subject: "Test",
    text: "Test",
    html: "<p>Test</p>",
    apiKey: "re_test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true };
    }
  });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.options.headers.Authorization, "Bearer re_test");
  await assert.rejects(
    () => sendTransactionalEmail({ to: "owner@example.com", from: "no-reply@example.com", subject: "Test", text: "Test", html: "", apiKey: "re_test", fetchImpl: async () => ({ ok: false }) }),
    (error) => error.name === "EmailDeliveryError" && error.message === "Email delivery failed"
  );
});

test("Gmail SMTP configuration is provider-specific and parses secure mode safely", async () => {
  assert.equal(parseSmtpSecure("true"), true);
  assert.equal(parseSmtpSecure("false"), false);
  assert.equal(parseSmtpSecure("unexpected", true), true);

  const config = readGmailSmtpConfig({
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "abdrabo.system@gmail.com",
    SMTP_APP_PASSWORD: "app-password-not-logged",
    MAIL_FROM_NAME: "Mr. Ahmed Abdrabo System"
  });
  assert.equal(config.configured, true);
  assert.equal(config.secure, true);
  assert.equal(config.fromEmail, "abdrabo.system@gmail.com");
  assert.equal(emailProviderStatus(EMAIL_PROVIDERS.GMAIL_SMTP, { smtpConfig: config }).configured, true);
  assert.equal(emailProviderStatus(EMAIL_PROVIDERS.GMAIL_SMTP, { smtpConfig: readGmailSmtpConfig({
    SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465", SMTP_SECURE: "true", SMTP_USER: "abdrabo.system@gmail.com", SMTP_APP_PASSWORD: ""
  }) }).configured, false);

  let transportOptions = null;
  const transporter = {
    sendMail: async (message) => { assert.equal(message.from, "Mr. Ahmed Abdrabo System <abdrabo.system@gmail.com>"); }
  };
  const created = createGmailTransporter(config, { createTransportImpl: (options) => { transportOptions = options; return transporter; } });
  assert.equal(created, transporter);
  assert.equal(transportOptions.host, "smtp.gmail.com");
  assert.equal(transportOptions.port, 465);
  assert.equal(transportOptions.secure, true);
  assert.equal(transportOptions.auth.user, "abdrabo.system@gmail.com");
  await sendPasswordRecoveryEmail({ provider: EMAIL_PROVIDERS.GMAIL_SMTP, to: "owner@example.com", fromEmail: config.fromEmail, senderName: config.fromName, smtpConfig: config, transporter, subject: "Test", text: "Test", html: "<p>Test</p>" });

  const defaults = readGmailSmtpConfig({
    SMTP_USER: "abdrabo.system@gmail.com",
    SMTP_APP_PASSWORD: "app-password-not-logged"
  });
  assert.equal(defaults.host, "smtp.gmail.com");
  assert.equal(defaults.port, 465);
  assert.equal(defaults.configured, true);
});

test("Gmail is the default provider and does not require a Resend key", async () => {
  const environment = {
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_APP_PASSWORD: process.env.SMTP_APP_PASSWORD,
    MAIL_FROM_NAME: process.env.MAIL_FROM_NAME,
    MAIL_FROM_EMAIL: process.env.MAIL_FROM_EMAIL,
    PASSWORD_RESET_SECRET: process.env.PASSWORD_RESET_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY
  };
  Object.assign(process.env, {
    EMAIL_PROVIDER: "gmail-smtp",
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "abdrabo.system@gmail.com",
    SMTP_APP_PASSWORD: "app-password-not-logged",
    MAIL_FROM_NAME: "Mr. Ahmed Abdrabo System",
    MAIL_FROM_EMAIL: "abdrabo.system@gmail.com",
    PASSWORD_RESET_SECRET: "d".repeat(32)
  });
  delete process.env.RESEND_API_KEY;
  try {
    const db = async (text) => text.includes("system_settings")
      ? { rowCount: 1, rows: [{ key: "password_recovery_enabled", value_json: true, updated_at: new Date() }] }
      : { rowCount: 0, rows: [] };
    const config = await getPasswordRecoveryConfig(db);
    assert.equal(config.provider, EMAIL_PROVIDERS.GMAIL_SMTP);
    assert.equal(config.apiKeyConfigured, false);
    assert.equal(config.providerConfigured, true);
    assert.equal(config.configured, true);
    assert.equal(config.enabled, true);
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("configured environment enables recovery on a fresh database but honors an explicit disable", async () => {
  const environment = {
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_APP_PASSWORD: process.env.SMTP_APP_PASSWORD,
    MAIL_FROM_EMAIL: process.env.MAIL_FROM_EMAIL,
    PASSWORD_RESET_SECRET: process.env.PASSWORD_RESET_SECRET
  };
  Object.assign(process.env, {
    EMAIL_PROVIDER: "gmail-smtp",
    SMTP_USER: "abdrabo.system@gmail.com",
    SMTP_APP_PASSWORD: "app-password-not-logged",
    PASSWORD_RESET_SECRET: "e".repeat(32)
  });
  try {
    const freshDatabase = async () => ({ rowCount: 0, rows: [] });
    const freshConfig = await getPasswordRecoveryConfig(freshDatabase);
    assert.equal(freshConfig.enabled, true);
    assert.equal(freshConfig.requestedEnabled, true);

    const explicitlyDisabledDatabase = async (text) => text.includes("FROM system_settings")
      ? { rowCount: 1, rows: [{ key: "password_recovery_enabled", value_json: false, updated_at: new Date() }] }
      : { rowCount: 0, rows: [] };
    const disabledConfig = await getPasswordRecoveryConfig(explicitlyDisabledDatabase);
    assert.equal(disabledConfig.enabled, false);
    assert.equal(disabledConfig.requestedEnabled, false);
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
