import nodemailer from "nodemailer";
import { promises as dns } from "node:dns";

export const EMAIL_PROVIDERS = Object.freeze({
  GMAIL_SMTP: "gmail-smtp",
  RESEND: "resend"
});

export const EMAIL_MAX_RETRIES = 3;
export const EMAIL_RETRY_INITIAL_DELAY_MS = 1_000;
const GMAIL_SMTP_HOST = "smtp.gmail.com";

export class EmailDeliveryError extends Error {
  constructor(message = "Email delivery failed", options = {}) {
    super(message, options);
    this.name = "EmailDeliveryError";
  }
}

function emailErrorDetails(error) {
  const cause = error?.cause || error;
  return {
    name: cause?.name || "Error",
    message: cause?.message || String(cause),
    code: cause?.code,
    responseCode: cause?.responseCode,
    command: cause?.command
  };
}

function logEmailFailure(operation, context, error) {
  console.error(`[email] ${operation} failed`, { ...context, error: emailErrorDetails(error) });
}

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

async function resolveGmailIpv4() {
  try {
    const result = await dns.lookup(GMAIL_SMTP_HOST, { family: 4 });
    return result.address;
  } catch (error) {
    console.warn("[email] Gmail IPv4 DNS lookup failed; using hostname fallback", {
      host: GMAIL_SMTP_HOST,
      error: { name: error?.name || "Error", message: error?.message || String(error), code: error?.code }
    });
    return GMAIL_SMTP_HOST;
  }
}

async function withEmailRetries(operation, task, { context = {}, maxRetries = EMAIL_MAX_RETRIES, sleepImpl = sleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const attemptContext = typeof context === "function" ? context(attempt) : context;
      logEmailFailure(`${operation} attempt ${attempt + 1}`, attemptContext, error);
      if (attempt === maxRetries) break;
      const delayMs = EMAIL_RETRY_INITIAL_DELAY_MS * (2 ** attempt);
      console.warn(`[email] ${operation} retry scheduled`, { attempt: attempt + 2, delayMs, ...attemptContext });
      await sleepImpl(delayMs);
    }
  }
  throw lastError;
}

function gmailTransportConfigForAttempt(config, attempt) {
  const primaryPort = Number(config.port);
  const fallbackPort = primaryPort === 465 ? 587 : primaryPort === 587 ? 465 : null;
  if (!fallbackPort || attempt % 2 === 0) return config;
  return { ...config, port: fallbackPort, secure: fallbackPort === 465 };
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
      socketTimeout: 10_000,
      tls: { servername: config.servername || GMAIL_SMTP_HOST }
    });
  } catch (error) {
    logEmailFailure("gmail transporter creation", { host: config.host, port: config.port, secure: config.secure }, error);
    throw new EmailDeliveryError("Email delivery failed", { cause: error });
  }
}

export async function sendGmailEmail({ to, fromName, fromEmail, subject, text, html, smtpConfig = readGmailSmtpConfig(), transporter = null, createTransportImpl, sleepImpl, maxRetries = EMAIL_MAX_RETRIES } = {}) {
  if (!validEmail(to) || !smtpConfig?.configured) throw new EmailDeliveryError();
  const baseTransportConfig = transporter
    ? smtpConfig
    : { ...smtpConfig, host: await resolveGmailIpv4(), servername: GMAIL_SMTP_HOST };
  const message = {
      from: senderAddress(fromName || smtpConfig.fromName, fromEmail || smtpConfig.fromEmail),
      to,
      subject: String(subject || ""),
      text: String(text || ""),
      html: String(html || "")
  };
  try {
    await withEmailRetries("gmail sendMail", (attempt) => {
      const transportConfig = gmailTransportConfigForAttempt(baseTransportConfig, attempt);
      const mailer = transporter || createGmailTransporter(transportConfig, { createTransportImpl });
      return mailer.sendMail(message);
    }, {
      context: (attempt) => {
        const transportConfig = gmailTransportConfigForAttempt(baseTransportConfig, attempt);
        return { to, host: transportConfig.host, port: transportConfig.port, secure: transportConfig.secure };
      },
      sleepImpl,
      maxRetries
    });
    return { ok: true };
  } catch (error) {
    throw new EmailDeliveryError("Email delivery failed", { cause: error });
  }
}

export async function verifyGmailSmtp({ smtpConfig = readGmailSmtpConfig(), transporter = null, createTransportImpl } = {}) {
  if (!smtpConfig?.configured) throw new EmailDeliveryError();
  const transportConfig = transporter
    ? smtpConfig
    : { ...smtpConfig, host: await resolveGmailIpv4(), servername: GMAIL_SMTP_HOST };
  const mailer = transporter || createGmailTransporter(transportConfig, { createTransportImpl });
  try {
    await mailer.verify();
    return { ok: true };
  } catch (error) {
    logEmailFailure("gmail SMTP verify", { host: transportConfig.host, port: transportConfig.port, secure: transportConfig.secure }, error);
    throw new EmailDeliveryError("Email delivery failed", { cause: error });
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
  } catch (error) {
    logEmailFailure("Resend request", { to }, error);
    throw new EmailDeliveryError("Email delivery failed", { cause: error });
  }
  if (!response?.ok) {
    const error = new Error(`Resend API returned HTTP ${response?.status ?? "unknown"}${response?.statusText ? ` ${response.statusText}` : ""}`);
    error.code = "resend_http_error";
    error.responseCode = response?.status;
    logEmailFailure("Resend request", { to }, error);
    throw new EmailDeliveryError("Email delivery failed", { cause: error });
  }
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

export async function sendPasswordRecoveryEmail({ provider, to, subject, text, html, apiKey, fromEmail, senderName, smtpConfig, fetchImpl, transporter, createTransportImpl, sleepImpl, maxRetries = EMAIL_MAX_RETRIES } = {}) {
  if (provider === EMAIL_PROVIDERS.GMAIL_SMTP) {
    return sendGmailEmail({ to, fromName: senderName || smtpConfig?.fromName, fromEmail: fromEmail || smtpConfig?.fromEmail, subject, text, html, smtpConfig, transporter, createTransportImpl, sleepImpl, maxRetries });
  }
  if (provider === EMAIL_PROVIDERS.RESEND) {
    return sendResendEmail({ to, from: fromEmail, subject, text, html, apiKey, fetchImpl });
  }
  throw new EmailDeliveryError();
}

// Backwards-compatible explicit Resend entry point for existing callers and tests.
export const sendTransactionalEmail = sendResendEmail;
