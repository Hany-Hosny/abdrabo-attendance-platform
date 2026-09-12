const UNRESTRICTED_ROLES = new Set(["owner", "admin"]);

export function normalizeGroupIds(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .map((groupId) => Number(groupId))
    .filter((groupId) => Number.isSafeInteger(groupId) && groupId > 0))]
    .sort((left, right) => left - right);
}

export function isGroupScopeRestricted(user) {
  if (!user || !user.role) return false;
  return !UNRESTRICTED_ROLES.has(String(user?.role || ""));
}

export function hasGroupAccess(user, groupId) {
  if (!isGroupScopeRestricted(user)) return true;
  return normalizeGroupIds(user?.group_ids).includes(Number(groupId));
}

export function appendGroupScope(filters, values, user, column = "g.id") {
  if (!isGroupScopeRestricted(user)) return;
  values.push(normalizeGroupIds(user?.group_ids));
  filters.push(`${column} = ANY($${values.length}::int[])`);
}

export function parseGroupIds(value) {
  if (value === undefined || value === null) return { ok: true, groupIds: [] };
  if (!Array.isArray(value)) return { ok: false, status: "invalid_group_ids" };
  const raw = value.map((groupId) => String(groupId).trim());
  if (raw.some((groupId) => !/^\d+$/.test(groupId))) return { ok: false, status: "invalid_group_ids" };
  const groupIds = normalizeGroupIds(raw);
  if (groupIds.length !== new Set(raw).size) return { ok: false, status: "invalid_group_ids" };
  return { ok: true, groupIds };
}

export function canAssignGroups(actor, groupIds) {
  if (!isGroupScopeRestricted(actor)) return true;
  const allowed = new Set(normalizeGroupIds(actor?.group_ids));
  return normalizeGroupIds(groupIds).every((groupId) => allowed.has(groupId));
}
