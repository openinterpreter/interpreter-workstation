export type BrowserAccessPolicyMode = 'ask' | 'deny' | 'all' | 'allowList';
export type BrowserAccessPermissionKind = 'read' | 'write' | 'action';

export const BROWSER_ACCESS_PERMISSION_KINDS: BrowserAccessPermissionKind[] = [
  'read',
  'write',
  'action',
];

export interface BrowserAccessRule {
  mode: BrowserAccessPolicyMode;
  allowedPatterns: string[];
}

export type BrowserAccessPermissionRules = Record<BrowserAccessPermissionKind, BrowserAccessRule>;

export interface BrowserAccessPolicy {
  permissions: BrowserAccessPermissionRules;
  profilePolicies: BrowserAccessProfilePolicy[];
}

export interface BrowserAccessProfilePolicy {
  profileId: string;
  permissions: BrowserAccessPermissionRules;
}

export interface BrowserAccessPatternParts {
  hostPattern: string;
  pathPattern: string;
  portPattern: string | null;
}

export const DEFAULT_BROWSER_ACCESS_POLICY: BrowserAccessPolicy = {
  permissions: {
    read: { mode: 'ask', allowedPatterns: [] },
    write: { mode: 'ask', allowedPatterns: [] },
    action: { mode: 'ask', allowedPatterns: [] },
  },
  profilePolicies: [],
};

const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validateHostname(hostname: string): void {
  const labels = hostname.split('.');
  if (labels.length === 0 || labels.some((label) => !HOST_LABEL_PATTERN.test(label))) {
    throw new Error('Use a hostname like example.com, localhost, or 127.0.0.1.');
  }
}

function parseAuthorityPattern(authorityPattern: string): {
  hostPattern: string;
  portPattern: string | null;
} {
  const trimmed = authorityPattern.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) {
    throw new Error('Enter a hostname like example.com/*.');
  }

  const colonIndex = trimmed.lastIndexOf(':');
  if (colonIndex === -1) {
    return { hostPattern: trimmed, portPattern: null };
  }

  if (trimmed.indexOf(':') !== colonIndex) {
    throw new Error('IPv6 patterns are not supported.');
  }

  const hostPattern = trimmed.slice(0, colonIndex);
  const portPattern = trimmed.slice(colonIndex + 1);
  if (!hostPattern || !portPattern) {
    throw new Error('Include both a hostname and a port, like localhost:3000/*.');
  }
  if (portPattern !== '*' && !/^\d+$/.test(portPattern)) {
    throw new Error('Ports must be numeric, like 3000.');
  }

  return { hostPattern, portPattern };
}

function validateHostPattern(hostPattern: string): void {
  if (hostPattern === '*') {
    return;
  }
  if (hostPattern.startsWith('*.')) {
    validateHostname(hostPattern.slice(2));
    return;
  }
  if (hostPattern.includes('*')) {
    throw new Error('Use "*" only by itself or as a "*." prefix for subdomains.');
  }
  validateHostname(hostPattern);
}

function normalizePathPattern(pathPattern: string): string {
  const trimmed = pathPattern.trim();
  if (!trimmed || trimmed === '/') {
    return '/*';
  }
  if (!trimmed.startsWith('/')) {
    throw new Error('Paths must start with "/", like /docs/*.');
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('Rules cannot include query strings or URL fragments.');
  }
  if (/\s/.test(trimmed)) {
    throw new Error('Rules cannot contain spaces.');
  }
  if (trimmed.endsWith('/')) {
    return `${trimmed}*`;
  }
  return trimmed;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function getEffectiveUrlPort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  if (url.protocol === 'https:') {
    return '443';
  }
  if (url.protocol === 'http:') {
    return '80';
  }
  return '';
}

export function normalizeBrowserAccessPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new Error('Rule cannot be empty.');
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('Rules cannot include query strings or URL fragments.');
  }
  if (/\s/.test(trimmed)) {
    throw new Error('Rules cannot contain spaces.');
  }

  let withoutScheme = trimmed;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1]?.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error('Only http and https page rules are supported.');
    }
    withoutScheme = trimmed.slice(schemeMatch[0].length);
  }

  if (withoutScheme.startsWith('/')) {
    throw new Error('Start each rule with a hostname, like example.com/*.');
  }

  const slashIndex = withoutScheme.indexOf('/');
  const authorityPattern = slashIndex === -1 ? withoutScheme : withoutScheme.slice(0, slashIndex);
  const pathPattern = slashIndex === -1 ? '/*' : withoutScheme.slice(slashIndex);
  const { hostPattern, portPattern } = parseAuthorityPattern(authorityPattern);

  validateHostPattern(hostPattern);

  const normalizedAuthority = portPattern ? `${hostPattern}:${portPattern}` : hostPattern;
  return `${normalizedAuthority}${normalizePathPattern(pathPattern)}`;
}

export function parseBrowserAccessPattern(pattern: string): BrowserAccessPatternParts {
  const normalizedPattern = normalizeBrowserAccessPattern(pattern);
  const slashIndex = normalizedPattern.indexOf('/');
  const authorityPattern = normalizedPattern.slice(0, slashIndex);
  const pathPattern = normalizedPattern.slice(slashIndex);
  const colonIndex = authorityPattern.lastIndexOf(':');

  if (colonIndex === -1) {
    return {
      hostPattern: authorityPattern,
      pathPattern,
      portPattern: null,
    };
  }

  return {
    hostPattern: authorityPattern.slice(0, colonIndex),
    pathPattern,
    portPattern: authorityPattern.slice(colonIndex + 1),
  };
}

function normalizeBrowserAccessPolicyMode(mode: unknown): BrowserAccessPolicyMode {
  return mode === 'all'
    ? 'all'
    : mode === 'deny'
      ? 'deny'
      : mode === 'allowList'
        ? 'allowList'
        : 'ask';
}

function normalizeBrowserAccessPatterns(patterns: unknown): string[] {
  const rawPatterns = Array.isArray(patterns) ? patterns : [];
  return Array.from(
    new Set(
      rawPatterns
        .map((pattern) => normalizeBrowserAccessPattern(pattern))
        .filter((pattern) => pattern.length > 0),
    ),
  );

}

function normalizeBrowserAccessRule(rule: unknown): BrowserAccessRule {
  if (!rule || typeof rule !== 'object') {
    throw new Error('Browser access rules must define mode and allowedPatterns.');
  }

  const rawRule = rule as Partial<BrowserAccessRule>;
  return {
    mode: normalizeBrowserAccessPolicyMode(rawRule.mode),
    allowedPatterns: normalizeBrowserAccessPatterns(rawRule.allowedPatterns),
  };
}

function normalizeBrowserAccessPermissionRules(permissions: unknown): BrowserAccessPermissionRules {
  if (!permissions || typeof permissions !== 'object') {
    throw new Error('Browser access policy must define read, write, and action permissions.');
  }

  const rawPermissions = permissions as Partial<BrowserAccessPermissionRules>;
  return {
    read: normalizeBrowserAccessRule(rawPermissions.read),
    write: normalizeBrowserAccessRule(rawPermissions.write),
    action: normalizeBrowserAccessRule(rawPermissions.action),
  };
}

function normalizeBrowserAccessProfilePolicies(policy: BrowserAccessPolicy | null | undefined): BrowserAccessProfilePolicy[] {
  const rawProfilePolicies = Array.isArray(policy?.profilePolicies) ? policy.profilePolicies : [];
  const byProfileId = new Map<string, BrowserAccessProfilePolicy>();

  for (const rawProfilePolicy of rawProfilePolicies) {
    if (!rawProfilePolicy || typeof rawProfilePolicy !== 'object') {
      continue;
    }

    const profilePolicy = rawProfilePolicy as Partial<BrowserAccessProfilePolicy>;
    const profileId = typeof profilePolicy.profileId === 'string'
      ? profilePolicy.profileId.trim()
      : '';
    if (!profileId) {
      continue;
    }

    byProfileId.set(profileId, {
      profileId,
      permissions: normalizeBrowserAccessPermissionRules(profilePolicy.permissions),
    });
  }

  return Array.from(byProfileId.values());
}

export function normalizeBrowserAccessPolicy(policy: BrowserAccessPolicy | null | undefined): BrowserAccessPolicy {
  if (policy === null || policy === undefined) {
    return DEFAULT_BROWSER_ACCESS_POLICY;
  }

  return {
    permissions: normalizeBrowserAccessPermissionRules(policy.permissions),
    profilePolicies: normalizeBrowserAccessProfilePolicies(policy),
  };
}

export function getBrowserAccessProfilePolicy(
  policy: BrowserAccessPolicy | null | undefined,
  profileId: string | null | undefined,
): BrowserAccessProfilePolicy | null {
  const normalizedPolicy = normalizeBrowserAccessPolicy(policy);
  const normalizedProfileId = profileId?.trim();
  if (!normalizedProfileId) {
    return null;
  }

  return normalizedPolicy.profilePolicies.find((profilePolicy) => profilePolicy.profileId === normalizedProfileId) ?? null;
}

function resolveBrowserAccessPolicyForProfile(
  policy: BrowserAccessPolicy | null | undefined,
  profileId: string | null | undefined,
): BrowserAccessPermissionRules {
  const normalizedPolicy = normalizeBrowserAccessPolicy(policy);
  const profilePolicy = getBrowserAccessProfilePolicy(normalizedPolicy, profileId);
  if (!profilePolicy) {
    return normalizedPolicy.permissions;
  }

  return profilePolicy.permissions;
}

function matchesHostPattern(hostname: string, hostPattern: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  if (hostPattern === '*') {
    return true;
  }
  if (hostPattern.startsWith('*.')) {
    const suffix = hostPattern.slice(2);
    return normalizedHostname.endsWith(`.${suffix}`);
  }
  return normalizedHostname === hostPattern;
}

function matchesPortPattern(url: URL, portPattern: string | null): boolean {
  if (!portPattern) {
    return true;
  }
  if (portPattern === '*') {
    return true;
  }
  return getEffectiveUrlPort(url) === portPattern;
}

function matchesPathPattern(pathname: string, pathPattern: string): boolean {
  if (pathPattern === '/*') {
    return true;
  }

  if (pathPattern.endsWith('/*') && pathPattern.indexOf('*') === pathPattern.length - 1) {
    const prefix = pathPattern.slice(0, -2);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }

  const regex = new RegExp(`^${escapeRegex(pathPattern).replace(/\\\*/g, '.*')}$`);
  return regex.test(pathname);
}

export function doesBrowserPatternMatchUrl(pattern: string, urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  const parts = parseBrowserAccessPattern(pattern);
  return matchesHostPattern(url.hostname, parts.hostPattern)
    && matchesPortPattern(url, parts.portPattern)
    && matchesPathPattern(url.pathname || '/', parts.pathPattern);
}

export function doesBrowserAccessPolicyAllowUrl(
  policy: BrowserAccessPolicy | null | undefined,
  urlString: string,
  profileId?: string | null,
  permissionKind: BrowserAccessPermissionKind = 'read',
): boolean {
  const permissionRules = resolveBrowserAccessPolicyForProfile(policy, profileId);
  const rule = permissionRules[permissionKind];
  if (rule.mode === 'all') {
    return true;
  }
  if (rule.mode === 'ask' || rule.mode === 'deny') {
    return false;
  }

  return rule.allowedPatterns.some((pattern) => doesBrowserPatternMatchUrl(pattern, urlString));
}

export function formatBrowserAccessPolicyPatterns(
  policy: BrowserAccessPolicy,
  permissionKind: BrowserAccessPermissionKind = 'read',
): string {
  const normalizedPolicy = normalizeBrowserAccessPolicy(policy);
  const rule = normalizedPolicy.permissions[permissionKind];
  if (rule.mode === 'all') {
    return 'all browser pages';
  }
  if (rule.mode === 'ask') {
    return 'ask before use';
  }
  if (rule.mode === 'deny') {
    return 'no browser pages';
  }
  if (rule.allowedPatterns.length === 0) {
    return 'no matching pages';
  }
  return rule.allowedPatterns.join(', ');
}
