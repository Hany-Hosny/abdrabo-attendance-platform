import crypto from "node:crypto";
import "../config/env.js";

export class SecretStorageError extends Error {
  constructor(message = "Secret storage is unavailable") {
    super(message);
    this.name = "SecretStorageError";
  }
}

function masterKey() {
  const configured = String(process.env.SETTINGS_ENCRYPTION_KEY || "");
  if (configured.length < 32) throw new SecretStorageError();
  if (/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured, "hex");
  return crypto.createHash("sha256").update(configured, "utf8").digest();
}

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    encryptedValue: encrypted.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url")
  };
}

export function decryptSecret(record) {
  if (!record?.encrypted_value || !record?.iv || !record?.auth_tag) throw new SecretStorageError();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(record.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(record.auth_tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.encrypted_value, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch (_error) {
    throw new SecretStorageError();
  }
}

export function hasEncryptionKey() {
  try {
    masterKey();
    return true;
  } catch (_error) {
    return false;
  }
}
