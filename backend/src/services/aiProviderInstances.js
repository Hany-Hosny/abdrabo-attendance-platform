import { randomUUID } from "node:crypto";
import { pool, query } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { decryptSecret, encryptSecret, SecretStorageError } from "./secretStorage.js";
import { AI_PROVIDERS } from "./aiProviderRegistry.js";

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_HEDGE_DELAY_MS = 500;
const VALID_HEALTH = new Set(["healthy", "rate_limited", "temporarily_failed", "configuration_problem", "unknown"]);

function executeWith(db) { return typeof db === "function" ? db : db.query.bind(db); }
function providerTypeOrThrow(value) {
  const providerType = String(value || "").trim();
  if (!Object.prototype.hasOwnProperty.call(AI_PROVIDERS, providerType)) throw new Error("invalid_ai_provider");
  return providerType;
}
function cleanString(value, max = 200) {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error("invalid_ai_provider_instance");
  return result;
}
function normalizeInput(input = {}, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_ai_provider_instance");
  const result = {};
  if (!partial || Object.prototype.hasOwnProperty.call(input, "providerType")) result.providerType = providerTypeOrThrow(input.providerType);
  if (!partial || Object.prototype.hasOwnProperty.call(input, "displayName")) result.displayName = cleanString(input.displayName, 120);
  for (const key of ["enabled", "routingEnabled"]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      if (typeof input[key] !== "boolean") throw new Error("invalid_ai_provider_instance");
      result[key] = input[key];
    }
  }
  for (const [key, min, max] of [["priority", 1, 100000], ["timeoutMs", 1000, 120000], ["hedgeDelayMs", 0, 10000], ["maxConcurrency", 1, 1000], ["weight", 1, 1000]]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (input[key] === null && key === "maxConcurrency") { result[key] = null; continue; }
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_ai_provider_${key}`);
    result[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "modelId")) {
    result.modelId = input.modelId === null || input.modelId === "" ? null : cleanString(input.modelId, 200);
  }
  if (Object.prototype.hasOwnProperty.call(input, "providerConfig")) {
    if (!input.providerConfig || typeof input.providerConfig !== "object" || Array.isArray(input.providerConfig)) throw new Error("invalid_ai_provider_instance");
    result.providerConfig = input.providerConfig;
  }
  return result;
}
function safeRow(row) {
  return {
    id: row.id,
    providerType: row.provider_type,
    label: AI_PROVIDERS[row.provider_type]?.label || row.provider_type,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
    routingEnabled: Boolean(row.routing_enabled),
    configured: Boolean(row.credential_encrypted && row.credential_iv && row.credential_auth_tag),
    modelId: row.model_id || null,
    priority: Number(row.priority),
    weight: Number(row.weight || 1),
    timeoutMs: Number(row.timeout_ms),
    hedgeDelayMs: Number(row.hedge_delay_ms || DEFAULT_HEDGE_DELAY_MS),
    maxConcurrency: row.max_concurrency === null ? null : Number(row.max_concurrency),
    providerConfig: row.provider_config_json || {},
    healthState: VALID_HEALTH.has(row.health_state) ? row.health_state : "unknown",
    cooldownUntil: row.cooldown_until || null,
    lastSuccessAt: row.last_success_at || null,
    lastFailureAt: row.last_failure_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
const SELECT = `SELECT id, provider_type, display_name, enabled, routing_enabled, model_id, priority, weight, timeout_ms, hedge_delay_ms, max_concurrency, provider_config_json, credential_encrypted, credential_iv, credential_auth_tag, health_state, cooldown_until, last_success_at, last_failure_at, created_at, updated_at FROM ai_provider_instances`;

export async function listAiProviderInstances({ db = query, eligibleOnly = false } = {}) {
  const execute = executeWith(db);
  const result = await execute(`${SELECT} ${eligibleOnly ? "WHERE enabled = TRUE AND routing_enabled = TRUE AND credential_encrypted IS NOT NULL AND health_state <> 'configuration_problem' AND (cooldown_until IS NULL OR cooldown_until <= NOW())" : ""} ORDER BY priority ASC, created_at ASC`, []);
  return (result.rows || []).map(safeRow);
}
export async function getAiProviderInstance(id, { db = query, includeCredentials = false } = {}) {
  const execute = executeWith(db);
  const result = await execute(`${SELECT} WHERE id = $1`, [id]);
  const row = result.rows?.[0];
  if (!row) throw new Error("ai_provider_instance_not_found");
  const value = safeRow(row);
  if (includeCredentials && row.credential_encrypted) {
    try { value.credentials = row.credential_encrypted ? JSON.parse(decryptSecret({ encrypted_value: row.credential_encrypted, iv: row.credential_iv, auth_tag: row.credential_auth_tag })) : {}; }
    catch (_error) { throw new SecretStorageError(); }
  }
  return value;
}
function credentialParts(credentials) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) throw new Error("invalid_ai_provider_credential");
  const value = JSON.stringify(credentials);
  if (value.length > 600) throw new Error("invalid_ai_provider_credential");
  const encrypted = encryptSecret(value);
  return [encrypted.encryptedValue, encrypted.iv, encrypted.authTag];
}
export async function createAiProviderInstance(input, { actorId, request = null, db = pool, audit = auditLog } = {}) {
  const value = normalizeInput(input);
  const providerType = value.providerType;
  const credentials = input.credentials;
  const parts = credentialParts(credentials);
  const result = await db.query(`INSERT INTO ai_provider_instances (id, provider_type, display_name, enabled, routing_enabled, model_id, priority, weight, timeout_ms, hedge_delay_ms, max_concurrency, provider_config_json, credential_encrypted, credential_iv, credential_auth_tag, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$16) RETURNING *`, [randomUUID(), providerType, value.displayName, value.enabled ?? false, value.routingEnabled ?? false, value.modelId ?? null, value.priority ?? 100, value.weight ?? 1, value.timeoutMs ?? DEFAULT_TIMEOUT_MS, value.hedgeDelayMs ?? DEFAULT_HEDGE_DELAY_MS, value.maxConcurrency ?? null, JSON.stringify(value.providerConfig || {}), ...parts, actorId || null]);
  await audit({ db, action: "ai_provider_instance_created", actorId, details: { provider_instance_id: result.rows[0].id, provider_type: providerType, display_name: value.displayName }, request });
  return safeRow(result.rows[0]);
}
export async function updateAiProviderInstance(id, input, { actorId, request = null, db = pool, audit = auditLog } = {}) {
  const current = await getAiProviderInstance(id, { db });
  const value = normalizeInput(input, { partial: true });
  const credentials = Object.prototype.hasOwnProperty.call(input, "credentials") ? credentialParts(input.credentials) : null;
  const result = await db.query(`UPDATE ai_provider_instances SET provider_type = COALESCE($2, provider_type), display_name = COALESCE($3, display_name), enabled = COALESCE($4, enabled), routing_enabled = COALESCE($5, routing_enabled), model_id = CASE WHEN $6::boolean THEN $7 ELSE model_id END, priority = COALESCE($8, priority), weight = COALESCE($9, weight), timeout_ms = COALESCE($10, timeout_ms), hedge_delay_ms = COALESCE($11, hedge_delay_ms), max_concurrency = CASE WHEN $12::boolean THEN $13 ELSE max_concurrency END, provider_config_json = CASE WHEN $14::boolean THEN $15::jsonb ELSE provider_config_json END, credential_encrypted = COALESCE($16, credential_encrypted), credential_iv = COALESCE($17, credential_iv), credential_auth_tag = COALESCE($18, credential_auth_tag), updated_by = $19, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, value.providerType || null, value.displayName || null, value.enabled ?? null, value.routingEnabled ?? null, Object.prototype.hasOwnProperty.call(value, "modelId"), value.modelId, value.priority ?? null, value.weight ?? null, value.timeoutMs ?? null, value.hedgeDelayMs ?? null, Object.prototype.hasOwnProperty.call(value, "maxConcurrency"), value.maxConcurrency, Object.prototype.hasOwnProperty.call(value, "providerConfig"), JSON.stringify(value.providerConfig || {}), credentials?.[0] || null, credentials?.[1] || null, credentials?.[2] || null, actorId || null]);
  if (!result.rows[0]) throw new Error("ai_provider_instance_not_found");
  await audit({ db, action: "ai_provider_instance_updated", actorId, details: { provider_instance_id: id, provider_type: current.providerType }, request });
  return safeRow(result.rows[0]);
}
export async function deleteAiProviderInstance(id, { actorId, request = null, db = pool, audit = auditLog } = {}) {
  const result = await db.query("DELETE FROM ai_provider_instances WHERE id = $1 RETURNING id, provider_type, display_name", [id]);
  if (!result.rows[0]) throw new Error("ai_provider_instance_not_found");
  await audit({ db, action: "ai_provider_instance_deleted", actorId, details: { provider_instance_id: id, provider_type: result.rows[0].provider_type, display_name: result.rows[0].display_name }, request });
  return { id };
}
export async function updateAiProviderHealth(id, { ok, failureStatus, outcome } = {}, { db = query } = {}) {
  const type = String(outcome?.type || "").toUpperCase();
  const isConfigurationFailure = ["AUTHENTICATION_ERROR", "PERMISSION_ERROR", "MODEL_UNAVAILABLE", "INVALID_CONFIGURATION"].includes(type) || ["provider_auth_failed", "provider_permission_denied", "provider_model_unavailable", "provider_not_configured"].includes(failureStatus);
  const state = ok ? "healthy" : isConfigurationFailure ? "configuration_problem" : failureStatus === "provider_rate_limited" || type === "RATE_LIMITED" ? "rate_limited" : "temporarily_failed";
  const cooldown = ok || state === "configuration_problem" ? null : new Date(Date.now() + (state === "rate_limited" ? 30000 : 10000));
  await executeWith(db)("UPDATE ai_provider_instances SET health_state = $2, cooldown_until = $3, last_success_at = CASE WHEN $4 THEN NOW() ELSE last_success_at END, last_failure_at = CASE WHEN $4 THEN last_failure_at ELSE NOW() END, updated_at = NOW() WHERE id = $1", [id, state, cooldown, Boolean(ok)]);
}
