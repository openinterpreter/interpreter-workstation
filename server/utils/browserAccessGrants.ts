import {
  getBrowserAccessProfilePolicy,
  normalizeBrowserAccessPolicy,
  type BrowserAccessPermissionKind,
  type BrowserAccessPermissionRules,
  type BrowserAccessPolicy,
} from '../../shared/browserAccessPolicy';

export type BrowserAccessGrant = {
  profileId: string;
  origin: string;
  permissionKind: BrowserAccessPermissionKind;
};

const sessionGrants = new Set<string>();
const temporaryGrants = new Set<string>();

function grantKey(grant: BrowserAccessGrant): string {
  return JSON.stringify(grant);
}

function patternFromOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Browser access grants only support http and https origins: ${origin}`);
  }
  return `${url.host}/*`;
}

function clonePermissionRules(rules: BrowserAccessPermissionRules): BrowserAccessPermissionRules {
  return {
    read: { mode: rules.read.mode, allowedPatterns: [...rules.read.allowedPatterns] },
    write: { mode: rules.write.mode, allowedPatterns: [...rules.write.allowedPatterns] },
    action: { mode: rules.action.mode, allowedPatterns: [...rules.action.allowedPatterns] },
  };
}

function applyGrant(policy: BrowserAccessPolicy, grant: BrowserAccessGrant): void {
  const pattern = patternFromOrigin(grant.origin);
  const existingProfilePolicy = getBrowserAccessProfilePolicy(policy, grant.profileId);
  let profilePolicy = policy.profilePolicies.find((entry) => entry.profileId === grant.profileId);

  if (!profilePolicy) {
    profilePolicy = {
      profileId: grant.profileId,
      permissions: clonePermissionRules(existingProfilePolicy?.permissions ?? policy.permissions),
    };
    policy.profilePolicies.push(profilePolicy);
  }

  const rule = profilePolicy.permissions[grant.permissionKind];
  if (rule.mode !== 'ask') {
    return;
  }
  rule.mode = 'allowList';
  if (!rule.allowedPatterns.includes(pattern)) {
    rule.allowedPatterns.push(pattern);
  }
}

export function addBrowserAccessSessionGrant(grant: BrowserAccessGrant): void {
  sessionGrants.add(grantKey(grant));
}

export async function withTemporaryBrowserAccessGrant<T>(
  grant: BrowserAccessGrant,
  callback: () => Promise<T>,
): Promise<T> {
  const key = grantKey(grant);
  temporaryGrants.add(key);
  try {
    return await callback();
  } finally {
    temporaryGrants.delete(key);
  }
}

export function getBrowserAccessPolicyWithGrants(basePolicy: BrowserAccessPolicy): BrowserAccessPolicy {
  const policy = normalizeBrowserAccessPolicy(basePolicy);
  for (const rawGrant of [...sessionGrants, ...temporaryGrants]) {
    applyGrant(policy, JSON.parse(rawGrant) as BrowserAccessGrant);
  }
  return policy;
}

export function clearBrowserAccessGrantsForTest(): void {
  sessionGrants.clear();
  temporaryGrants.clear();
}
