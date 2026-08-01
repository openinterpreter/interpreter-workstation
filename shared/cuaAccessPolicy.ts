export type CuaAccessPolicyMode = 'ask' | 'deny' | 'all';
export type CuaAccessPermissionKind = 'inspect' | 'control';

export const CUA_ACCESS_PERMISSION_KINDS: CuaAccessPermissionKind[] = [
  'inspect',
  'control',
];

export interface CuaAccessRule {
  mode: CuaAccessPolicyMode;
}

export type CuaAccessPermissionRules = Record<CuaAccessPermissionKind, CuaAccessRule>;

export interface CuaAccessAppPolicy {
  appId: string;
  displayName: string;
  permissions: CuaAccessPermissionRules;
}

export interface CuaAccessPolicy {
  permissions: CuaAccessPermissionRules;
  appPolicies: CuaAccessAppPolicy[];
}

export const DEFAULT_CUA_ACCESS_POLICY: CuaAccessPolicy = {
  permissions: {
    inspect: { mode: 'ask' },
    control: { mode: 'ask' },
  },
  appPolicies: [],
};

export function normalizeCuaAppId(appId: string): string {
  const normalized = appId.trim();
  if (!normalized) {
    throw new Error('Computer Use app rules require an app name.');
  }
  return normalized;
}

function normalizeCuaAccessPolicyMode(mode: unknown): CuaAccessPolicyMode {
  if (mode === 'ask' || mode === 'deny' || mode === 'all') {
    return mode;
  }
  throw new Error('Computer Use permission mode must be ask, deny, or all.');
}

function normalizeCuaAccessRule(rule: unknown): CuaAccessRule {
  if (!rule || typeof rule !== 'object') {
    throw new Error('Computer Use permission rules must define a mode.');
  }

  return {
    mode: normalizeCuaAccessPolicyMode((rule as Partial<CuaAccessRule>).mode),
  };
}

function normalizeCuaAccessPermissionRules(permissions: unknown): CuaAccessPermissionRules {
  if (!permissions || typeof permissions !== 'object') {
    throw new Error('Computer Use policy must define inspect and control permissions.');
  }

  const rawPermissions = permissions as Partial<CuaAccessPermissionRules>;
  return {
    inspect: normalizeCuaAccessRule(rawPermissions.inspect),
    control: normalizeCuaAccessRule(rawPermissions.control),
  };
}

function normalizeCuaAccessAppPolicies(policy: CuaAccessPolicy): CuaAccessAppPolicy[] {
  if (!Array.isArray(policy.appPolicies)) {
    throw new Error('Computer Use app policies must be an array.');
  }

  const byAppId = new Map<string, CuaAccessAppPolicy>();
  for (const rawAppPolicy of policy.appPolicies) {
    if (!rawAppPolicy || typeof rawAppPolicy !== 'object') {
      throw new Error('Computer Use app policy entries must be objects.');
    }

    const appPolicy = rawAppPolicy as Partial<CuaAccessAppPolicy>;
    const appId = normalizeCuaAppId(appPolicy.appId ?? '');
    byAppId.set(appId, {
      appId,
      displayName: appPolicy.displayName?.trim() || appId,
      permissions: normalizeCuaAccessPermissionRules(appPolicy.permissions),
    });
  }

  return Array.from(byAppId.values());
}

export function normalizeCuaAccessPolicy(policy: CuaAccessPolicy | null | undefined): CuaAccessPolicy {
  if (policy === null || policy === undefined) {
    return DEFAULT_CUA_ACCESS_POLICY;
  }

  return {
    permissions: normalizeCuaAccessPermissionRules(policy.permissions),
    appPolicies: normalizeCuaAccessAppPolicies(policy),
  };
}

export function getCuaAccessAppPolicy(
  policy: CuaAccessPolicy | null | undefined,
  appId: string | null | undefined,
): CuaAccessAppPolicy | null {
  const normalizedPolicy = normalizeCuaAccessPolicy(policy);
  const normalizedAppId = appId?.trim();
  if (!normalizedAppId) {
    return null;
  }

  return normalizedPolicy.appPolicies.find((appPolicy) => appPolicy.appId === normalizedAppId) ?? null;
}

export function resolveCuaAccessPolicyMode(
  policy: CuaAccessPolicy | null | undefined,
  appId: string | null | undefined,
  permissionKind: CuaAccessPermissionKind,
): CuaAccessPolicyMode {
  const normalizedPolicy = normalizeCuaAccessPolicy(policy);
  const appPolicy = getCuaAccessAppPolicy(normalizedPolicy, appId);
  return (appPolicy?.permissions ?? normalizedPolicy.permissions)[permissionKind].mode;
}

