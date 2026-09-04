import nodemailer from "nodemailer";

export const EMAIL_PROVIDERS = Object.freeze({
  GMAIL_SMTP: "gmail-smtp",
  RESEND: "resend"
});

export class EmailDeliveryError extends Error {
  constructor(message = "Email delivery failed") {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

export function parseSmtpSecure(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

export function readGmailSmtpConfig(env = process.env) {
  // Keep Gmail's standard connection defaults in code as well as docker-compose.
  // Railway/Nixpacks deployments do not evaluate docker-compose variable defaults.
  const host = String(env.SMTP_HOST || "smtp.gmail.com").trim();
  const configuredPort = env.SMTP_PORT === undefined || env.SMTP_PORT === null || String(env.SMTP_PORT).trim() === ""
    ? 465
    : Number(env.SMTP_PORT);
  const port = Number(configuredPort);
  const secure = parseSmtpSecure(env.SMTP_SECURE, port === 465);
  const user = String(env.SMTP_USER || "").trim();
  const appPassword = String(env.SMTP_APP_PASSWORD || "");
  const fromName = String(env.MAIL_FROM_NAME || "Mr. Ahmed Abdrabo System").trim() || "Mr. Ahmed Abdrabo System";
  const fromEmail = String(env.MAIL_FROM_EMAIL || user).trim().toLowerCase();
  return {
    host,
    port,
    secure,
    user,
    appPassword,
    fromName,
    fromEmail,
    configured: Boolean(host && Number.isInteger(port) && port > 0 && port <= 65535 && user && appPassword && validEmail(fromEmail))
  };
}

function senderAddress(fromName, fromEmail) {
  if (!validEmail(fromEmail)) throw new EmailDeliveryError();
  const safeName = String(fromName || "Mr. Ahmed Abdrabo System").replace(/[\r\n<>]/g, "").trim() || "Mr. Ahmed Abdrabo System";
  return `${safeName} <${fromEmail}>`;
}

export function createGmailTransporter(config, { createTransportImpl = nodemailer.createTransport } = {}) {
  if (!config?.configured || typeof createTransportImpl !== "function") throw new EmailDeliveryError();
  try {
    return createTransportImpl({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.appPassword },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000
    });
  } catch (_error) {
    throw new EmailDeliveryError();
  }
}

export async function sendGmailEmail({ to, fromName, fromEmail, subject, text, html, smtpConfig = readGmailSmtpConfig(), transporter = null, createTransportImpl } = {}) {
  if (!validEmail(to) || !smtpConfig?.configured) throw new EmailDeliveryError();
  const mailer = transporter || createGmailTransporter(smtpConfig, { createTransportImpl });
  try {
    await mailer.sendMail({
      from: senderAddress(fromName || smtpConfig.fromName, fromEmail || smtpConfig.fromEmail),
      to,
      subject: String(subject || ""),
      text: String(text || ""),
      html: String(html || "")
    });
    return { ok: true };
  } catch (_error) {
    throw new EmailDeliveryError();
  }
}

export async function verifyGmailSmtp({ smtpConfig = readGmailSmtpConfig(), transporter = null, createTransportImpl } = {}) {
  if (!smtpConfig?.configured) throw new EmailDeliveryError();
  const mailer = transporter || createGmailTransporter(smtpConfig, { createTransportImpl });
  try {
    await mailer.verify();
    return { ok: true };
  } catch (_error) {
    throw new EmailDeliveryError();
  }
}

export async function sendResendEmail({ to, from, subject, text, html, apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!validEmail(to) || !validEmail(from) || !apiKey || typeof fetchImpl !== "function") throw new EmailDeliveryError();
  let response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html })
    });
  } catch (_error) {
    throw new EmailDeliveryError();
  }
  if (!response?.ok) throw new EmailDeliveryError();
  return { ok: true };
}

export function emailProviderStatus(provider, { apiKey = "", fromEmail = "", smtpConfig = readGmailSmtpConfig() } = {}) {
  if (provider === EMAIL_PROVIDERS.GMAIL_SMTP) {
    return { provider, configured: Boolean(smtpConfig?.configured), credentialsConfigured: Boolean(smtpConfig?.configured), senderEmail: smtpConfig?.fromEmail || "", senderName: smtpConfig?.fromName || "Mr. Ahmed Abdrabo System" };
  }
  if (provider === EMAIL_PROVIDERS.RESEND) {
    return { provider, configured: Boolean(apiKey && validEmail(fromEmail)), credentialsConfigured: Boolean(apiKey), senderEmail: fromEmail, senderName: "Mr. Ahmed Abdrabo System" };
  }
  return { provider, configured: false, credentialsConfigured: false, senderEmail: fromEmail, senderName: "Mr. Ahmed Abdrabo System" };
}

export async function sendPasswordRecoveryEmail({ provider, to, subject, text, html, apiKey, fromEmail, senderName, smtpConfig, fetchImpl, transporter, createTransportImpl } = {}) {
  if (provider === EMAIL_PROVIDERS.GMAIL_SMTP) {
    return sendGmailEmail({ to, fromName: senderName || smtpConfig?.fromName, fromEmail: fromEmail || smtpConfig?.fromEmail, subject, text, html, smtpConfig, transporter, createTransportImpl });
  }
  if (provider === EMAIL_PROVIDERS.RESEND) {
    return sendResendEmail({ to, from: fromEmail, subject, text, html, apiKey, fetchImpl });
  }
  throw new EmailDeliveryError();
}

// Backwards-compatible explicit Resend entry point for existing callers and tests.
export const sendTransactionalEmail = sendResendEmail;
