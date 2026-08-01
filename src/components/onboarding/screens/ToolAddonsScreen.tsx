/**
 * ToolAddonsScreen
 *
 * Unified tools step:
 * 1. Discovered tools (from local MCP configs)
 * 2. Tool Store integrations
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  Check,
  ExternalLink,
  Globe,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { addToolServer, deleteToolServer, getOnboardingState, setOnboardingState, startToolServerOAuth } from '../../../api';
import { browserControl, mcpDiscovery, providers, servers, toolServers, openExternal } from '../../../ipc';
import { trackOnboardingError, trackSkillInstalled, trackSkillInstallFailed } from '../../../utils/telemetry';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { resolveRemoteToolServerSetupPhase } from '../../../../shared/toolServerAvailability';
import type { BrowserControlProfile, BrowserControlStatus } from '../../../../shared/types/browserControl';
import {
  BROWSER_ACCESS_PERMISSION_KINDS,
  DEFAULT_BROWSER_ACCESS_POLICY,
  type BrowserAccessPolicy,
  type BrowserAccessProfilePolicy,
  type BrowserAccessRule,
} from '../../../../shared/browserAccessPolicy';
import {
  MCP_STORE_ENTRIES,
  getFaviconUrl,
  matchStoreEntryForCandidate,
  type McpStoreEntry,
} from '../../tools/mcpStoreData';
import {
  buildOnboardingImportedToolSummary,
  mergeOnboardingImportedToolSummary,
} from '../../../../shared/types/onboardingState';
import { OnboardingModal } from '../components/OnboardingModal';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bucket = 'non-developer' | 'developer' | 'developer-local-ai';

interface ToolAddonsScreenProps {
  onNext: () => void;
  bucket: Bucket;
}

interface DiscoveredMcp {
  id: string;
  name: string;
  source: 'claude-code' | 'cursor';
  transport: 'stdio' | 'http' | 'sse' | 'websocket';
  startupCandidateId?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauthResource?: string;
}

interface McpDiscoveryResult {
  discovered: DiscoveredMcp[];
  sources: {
    claudeCode: { found: boolean; path: string };
    cursor: { found: boolean; path: string };
  };
}

interface ImportedAiSetupSnapshot {
  candidates: Array<{
    id: string;
    name: string;
    source: 'claude-code' | 'cursor';
    transport: 'stdio' | 'http' | 'sse' | 'websocket';
  }>;
}

type DetailsState =
  | { kind: 'store'; entry: McpStoreEntry }
  | { kind: 'discovered'; entry: DiscoveredMcp };

type ToolSetupPhase = 'setting-up' | 'needs-auth' | 'connected' | 'failed';

interface ToolSetupState {
  phase: ToolSetupPhase;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_GRID_SLOTS = 6;
const RESERVED_SCAN_SLOT_COUNT = 1;
// The browser setup card carries connection and per-profile access state, so it
// gets two grid columns instead of forcing every card in its row to match its
// height.
const RESERVED_BROWSER_EXTENSION_SLOT_COUNT = 2;
const PAGE_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const CHROME_EXTENSION_INSTALL_URL = 'https://chromewebstore.google.com/detail/interpreter-chrome-extens/bboaaphdpllilofamfpommlbafpellnb';
const BROWSER_PROFILE_PREVIEW_LIMIT = 3;

const STORE_PAGE_VARIANTS = {
  enter: (direction: 1 | -1) => ({
    x: direction === 1 ? 22 : -22,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
    transition: {
      x: { type: 'tween' as const, duration: 0.24, ease: PAGE_EASE },
      opacity: { type: 'tween' as const, duration: 0.2, ease: 'easeOut' as const },
    },
  },
  exit: (direction: 1 | -1) => ({
    x: direction === 1 ? -22 : 22,
    opacity: 0,
    transition: {
      x: { type: 'tween' as const, duration: 0.16, ease: 'easeIn' as const },
      opacity: { type: 'tween' as const, duration: 0.14, ease: 'easeIn' as const },
    },
  }),
};

const STORE_CATEGORY_KEYS: Record<McpStoreEntry['category'], string> = {
  productivity: 'onboarding.toolAddons.category.productivity',
  finance: 'onboarding.toolAddons.category.finance',
  data: 'onboarding.toolAddons.category.data',
  research: 'onboarding.toolAddons.category.research',
  developer: 'onboarding.toolAddons.category.developer',
  healthcare: 'onboarding.toolAddons.category.healthcare',
  academic: 'onboarding.toolAddons.category.academic',
};

const STORE_PRIORITY_BY_BUCKET: Record<Bucket, string[]> = {
  developer: [
    'github',
    'atlassian',
    'linear',
    'notion',
    'supabase',
    'sentry',
    'asana',
    'dropbox',
    'airtable',
    'intercom',
    'hubspot',
  ],
  'developer-local-ai': [
    'github',
    'supabase',
    'sentry',
    'linear',
    'notion',
    'atlassian',
    'asana',
    'dropbox',
    'airtable',
  ],
  'non-developer': [
    'notion',
    'asana',
    'dropbox',
    'box',
    'airtable',
    'hubspot',
    'stripe',
    'intercom',
    'monday',
    'atlassian',
    'linear',
    'youtube',
  ],
};

const BADGE_STYLE = {
  border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 48%, transparent)',
  backgroundColor: 'color-mix(in oklch, var(--oa-bg-subtle) 42%, transparent)',
};

const MODAL_STYLE = {
  border: 'var(--border-width) solid var(--oa-border)',
  backgroundColor: 'color-mix(in oklch, var(--oa-bg-input) 98%, var(--oa-bg-app) 2%)',
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.14)',
};

const DISCOVERED_PRIORITY_BY_BUCKET: Record<Bucket, string[]> = {
  developer: [
    'github',
    'git',
    'supabase',
    'postgres',
    'mysql',
    'docker',
    'notion',
    'slack',
    'linear',
    'jira',
  ],
  'developer-local-ai': [
    'ollama',
    'lmstudio',
    'github',
    'git',
    'supabase',
    'postgres',
    'docker',
    'notion',
  ],
  'non-developer': [
    'notion',
    'slack',
    'dropbox',
    'box',
    'airtable',
    'hubspot',
    'intercom',
    'monday',
    'asana',
    'calendar',
  ],
};
const NON_DEVELOPER_STORE_IDS = new Set(STORE_PRIORITY_BY_BUCKET['non-developer']);

// ---------------------------------------------------------------------------
// Known favicon domains for discovered tools
// ---------------------------------------------------------------------------

const DISCOVERED_FAVICON_DOMAINS: Record<string, string> = {
  lmstudio: 'lmstudio.ai',
  ollama: 'ollama.com',
  github: 'github.com',
  git: 'git-scm.com',
  supabase: 'supabase.com',
  postgres: 'postgresql.org',
  docker: 'docker.com',
  notion: 'notion.com',
  slack: 'slack.com',
  linear: 'linear.app',
  jira: 'atlassian.com',
  mysql: 'mysql.com',
};

function getDiscoveredFaviconUrl(mcp: DiscoveredMcp): string | null {
  const normalized = mcp.name.toLowerCase();
  for (const [token, domain] of Object.entries(DISCOVERED_FAVICON_DOMAINS)) {
    if (normalized.includes(token)) {
      return getFaviconUrl(domain);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDiscoveredDetailsPreview(mcp: DiscoveredMcp): string {
  if (mcp.transport === 'stdio') {
    const command = mcp.command || 'local command';
    const args = mcp.args && mcp.args.length > 0 ? ` ${mcp.args.join(' ')}` : '';
    return `${command}${args}`.trim();
  }
  return mcp.url || 'Remote MCP endpoint';
}

function getDiscoveredSummary(mcp: DiscoveredMcp, bucket: Bucket): string {
  if (bucket === 'non-developer') {
    if (mcp.id.startsWith('project-')) return 'Already configured for this workspace.';
    if (mcp.transport === 'stdio') return 'Ready to add from an app already set up on this computer.';
    return 'Ready to connect from an account you already use.';
  }

  if (mcp.id.startsWith('project-')) return 'Available from this workspace configuration.';
  if (mcp.transport === 'stdio') return 'Local integration available on this computer.';
  return 'Remote integration ready to connect.';
}

function getDiscoveredNameRank(name: string, bucket: Bucket): number {
  const normalized = name.toLowerCase();
  const priorities = DISCOVERED_PRIORITY_BY_BUCKET[bucket];
  const index = priorities.findIndex((token) => normalized.includes(token));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function getDiscoveredSourceRank(mcp: DiscoveredMcp, bucket: Bucket): number {
  if (mcp.id.startsWith('project-')) return bucket === 'non-developer' ? 2 : 0;
  if (mcp.source === 'claude-code') return bucket === 'non-developer' ? 1 : 1;
  return bucket === 'non-developer' ? 0 : 2;
}

function buildDiscoveredConfig(mcp: DiscoveredMcp): any {
  const config: any = {
    name: mcp.name,
    transport: mcp.transport,
    enabled: true,
  };

  if (mcp.transport === 'stdio') {
    config.command = mcp.command;
    config.args = mcp.args || [];
    config.env = mcp.env || {};
  } else {
    config.url = mcp.url;
    config.headers = mcp.headers || {};
    config.oauthResource = mcp.oauthResource;
  }

  return config;
}

function importedCandidateToDiscoveredMcp(candidate: ImportedAiSetupSnapshot['candidates'][number]): DiscoveredMcp {
  return {
    id: candidate.id,
    startupCandidateId: candidate.id,
    name: candidate.name,
    source: candidate.source,
    transport: candidate.transport,
  };
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function isAlreadyExistsError(errorMessage: string): boolean {
  return errorMessage.toLowerCase().includes('already exists');
}

function getGitHubCliAuthSetupErrorMessage(error?: string): string {
  const detail = error?.trim();
  if (detail) {
    return detail;
  }
  return 'GitHub CLI is not installed or not authenticated. Run "gh auth login" in a terminal, or set GH_TOKEN/GITHUB_TOKEN before starting Interpreter.';
}

async function persistDiscoveredMcpSummary(discoveredMcps: DiscoveredMcp[]): Promise<void> {
  const addition = buildOnboardingImportedToolSummary({
    detectedProviders: [],
    detectedTools: [],
    detectedConfigDirs: [],
    detectedApps: [],
    discoveredMcps: discoveredMcps.map((mcp) => ({
      name: mcp.name,
      source: mcp.source,
      transport: mcp.transport,
    })),
    generatedAt: new Date().toISOString(),
  });
  if (!addition.summary) return;

  const { state } = await getOnboardingState();
  const importedToolSummary = mergeOnboardingImportedToolSummary(state.importedToolSummary, addition);
  if (
    state.importedToolSummary.summary === importedToolSummary.summary &&
    state.importedToolSummary.sources.join('\n') === importedToolSummary.sources.join('\n')
  ) {
    return;
  }

  await setOnboardingState({
    ...state,
    importedToolSummary,
  });
}

interface OnboardingStoreCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  badgeLabel?: string;
  tone?: 'default' | 'discovered';
  setupState?: ToolSetupState;
  isAdded: boolean;
  addLabel: string;
  removeLabel: string;
  completeInBrowserLabel: string;
  detailsLabel: string;
  onAdd: () => void;
  onRemove: () => void;
  onDetails: () => void;
}

function OnboardingStoreCard({
  icon,
  title,
  description,
  setupState,
  isAdded,
  badgeLabel,
  tone = 'default',
  addLabel,
  removeLabel,
  completeInBrowserLabel,
  detailsLabel,
  onAdd,
  onRemove,
  onDetails,
}: OnboardingStoreCardProps) {
  const isAdding = setupState?.phase === 'setting-up';
  const needsAuth = setupState?.phase === 'needs-auth';
  const failedError = setupState?.phase === 'failed' ? setupState.error : null;

  return (
    <div
      className="relative flex h-full min-h-[132px] flex-col rounded-[16px] p-3"
      style={{
        border: tone === 'discovered'
          ? 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 14%, var(--oa-border) 86%)'
          : 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 52%, transparent)',
        backgroundColor: tone === 'discovered'
          ? 'color-mix(in oklch, var(--oa-bg-subtle) 12%, var(--oa-bg-app) 88%)'
          : 'color-mix(in oklch, var(--oa-bg-app) 96%, var(--oa-bg-subtle) 4%)',
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="shrink-0">{icon}</div>
            <div className="min-w-0 flex-1 pt-0.5">
              <h4 className="truncate text-[14px] font-medium text-foreground">{title}</h4>
            </div>
          </div>
          {badgeLabel ? (
            <span
              className="inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground"
              style={{
                border: tone === 'discovered'
                  ? 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 12%, var(--oa-border) 88%)'
                  : 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 48%, transparent)',
                backgroundColor: tone === 'discovered'
                  ? 'color-mix(in oklch, var(--oa-bg-subtle) 22%, transparent)'
                  : 'transparent',
              }}
            >
              {badgeLabel}
            </span>
          ) : null}
        </div>

        <div className="mt-3">
          <p className="text-[12px] leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>

      {failedError && (
        <p className="mt-2 text-xs whitespace-normal break-all text-destructive">
          {failedError}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <Button
          onClick={onDetails}
          variant="outline"
          size="xs"
          className="rounded-full px-2.5 text-muted-foreground shadow-none hover:border-[color-mix(in_oklch,var(--oa-border)_52%,transparent)] hover:bg-transparent hover:text-muted-foreground"
        >
          {detailsLabel}
        </Button>

        <div className="flex min-w-[76px] justify-end">
          {isAdded ? (
            <Button
              onClick={onRemove}
              variant="outline"
              size="xs"
              className="rounded-full px-2.5 shadow-none"
            >
              <X className="size-3.5" />
              {removeLabel}
            </Button>
          ) : needsAuth ? (
            <div className="inline-flex h-6 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-primary/10 px-2.5 text-[12px] text-primary">
              <Loader2 className="size-3.5 animate-spin" />
              {completeInBrowserLabel}
            </div>
          ) : (
            <Button
              onClick={onAdd}
              disabled={isAdding}
              variant="outline"
              size="xs"
              className="rounded-full px-2.5 shadow-none"
            >
              {isAdding ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )}
              {addLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBrowserName(browserName: string | null): string {
  switch ((browserName ?? '').trim().toLowerCase()) {
    case 'chrome':
      return 'Chrome';
    case 'chromium':
      return 'Chromium';
    case 'brave':
      return 'Brave';
    case 'edge':
    case 'microsoft edge':
      return 'Edge';
    default:
      return browserName?.trim() || 'Browser';
  }
}

function formatBrowserProfileName(profile: BrowserControlProfile): string {
  const browserName = formatBrowserName(profile.browserName);
  const profileName = profile.profileName?.trim();
  return profileName ? `${browserName} ${profileName}` : browserName;
}

function replaceProfilePolicy(
  policy: BrowserAccessPolicy,
  profileId: string,
  nextProfilePolicy: BrowserAccessProfilePolicy,
): BrowserAccessPolicy {
  return {
    ...policy,
    profilePolicies: [
      ...policy.profilePolicies.filter((profilePolicy) => profilePolicy.profileId !== profileId),
      nextProfilePolicy,
    ],
  };
}

function buildProfilePolicy(profileId: string, rule: BrowserAccessRule): BrowserAccessProfilePolicy {
  return {
    profileId,
    permissions: {
      read: rule,
      write: rule,
      action: rule,
    },
  };
}

function isProfileSelected(policy: BrowserAccessPolicy | null, profile: BrowserControlProfile): boolean {
  if (!profile.policyProfileId) {
    return false;
  }

  const profilePolicy = policy?.profilePolicies.find((candidate) => candidate.profileId === profile.policyProfileId);
  if (!profilePolicy) {
    return true;
  }

  return BROWSER_ACCESS_PERMISSION_KINDS.some((permissionKind) => profilePolicy.permissions[permissionKind].mode !== 'deny');
}

interface BrowserExtensionSetupCardProps {
  status: BrowserControlStatus | null;
  policy: BrowserAccessPolicy | null;
  loading: boolean;
  savingProfileId: string | null;
  error: string | null;
  onInstall: () => void;
  onRefresh: () => void;
  onSetProfileSelected: (profile: BrowserControlProfile, selected: boolean) => void;
}

function BrowserExtensionSetupCard({
  status,
  policy,
  loading,
  savingProfileId,
  error,
  onInstall,
  onRefresh,
  onSetProfileSelected,
}: BrowserExtensionSetupCardProps) {
  const { t } = useTranslation();
  const connectedProfiles = status?.profiles.filter((profile) => profile.connectionState === 'connected').length ?? 0;
  const connectedBrowsers = status?.connectedBrowsers ?? connectedProfiles;
  const isConnected = connectedProfiles > 0 || connectedBrowsers > 0;
  const profilePreview = status?.profiles.slice(0, BROWSER_PROFILE_PREVIEW_LIMIT) ?? [];
  const extraProfileCount = Math.max(0, (status?.profiles.length ?? 0) - profilePreview.length);
  const statusLabel = loading
    ? t('onboarding.toolAddons.browserExtensionChecking')
    : isConnected
      ? t('onboarding.toolAddons.browserExtensionConnected', { count: connectedProfiles || connectedBrowsers })
      : t('onboarding.toolAddons.browserExtensionDisconnected');

  return (
    <div
      className="relative flex h-full min-h-[132px] flex-col rounded-[16px] p-3 md:col-span-2"
      style={{
        border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 52%, transparent)',
        backgroundColor: 'color-mix(in oklch, var(--oa-bg-app) 96%, var(--oa-bg-subtle) 4%)',
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <Globe className="size-5 shrink-0 text-[var(--oa-text-muted)]" />
            <div className="min-w-0 flex-1 pt-0.5">
              <h4 className="truncate text-[14px] font-medium text-foreground">
                {t('onboarding.toolAddons.browserExtensionTitle')}
              </h4>
            </div>
          </div>
          <span
            className="inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground"
            style={{
              border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 48%, transparent)',
            }}
          >
            {t('onboarding.toolAddons.recommendedExtensionBadge')}
          </span>
        </div>

        <div className="mt-3 space-y-1.5">
          <p className="text-[12px] leading-5 text-muted-foreground">
            {t('onboarding.toolAddons.browserExtensionDescription')}
          </p>
          <p className="text-[12px] leading-5 text-muted-foreground">
            {t('onboarding.toolAddons.browserExtensionPermissionNote')}
          </p>
          <p className="text-[12px] leading-5 text-foreground">
            {statusLabel}
          </p>
          {profilePreview.length > 0 ? (
            <div className="space-y-1">
              {profilePreview.map((profile) => (
                <div
                  key={profile.profileId}
                  className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground"
                >
                  <label className="flex min-w-0 items-center gap-2">
                    {profile.policyProfileId ? (
                      <Checkbox
                        checked={isProfileSelected(policy, profile)}
                        disabled={savingProfileId === profile.policyProfileId}
                        onCheckedChange={(checked) => {
                          onSetProfileSelected(profile, checked === true);
                        }}
                        aria-label={t('onboarding.toolAddons.browserExtensionProfileToggle', {
                          profile: formatBrowserProfileName(profile),
                        })}
                      />
                    ) : null}
                    <span className="truncate">{formatBrowserProfileName(profile)}</span>
                  </label>
                  <span className="shrink-0">
                    {profile.connectionState === 'connected'
                      ? t('onboarding.toolAddons.browserExtensionProfileConnected')
                      : t('onboarding.toolAddons.browserExtensionProfileDetected')}
                  </span>
                </div>
              ))}
              {extraProfileCount > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {t('onboarding.toolAddons.browserExtensionMoreProfiles', { count: extraProfileCount })}
                </p>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p className="text-[11px] leading-5 text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <Button
          onClick={onRefresh}
          disabled={loading}
          variant="outline"
          size="xs"
          className="rounded-full px-2.5 text-muted-foreground shadow-none hover:border-[color-mix(in_oklch,var(--oa-border)_52%,transparent)] hover:bg-transparent hover:text-muted-foreground"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t('onboarding.toolAddons.browserExtensionRefresh')}
        </Button>

        <Button
          onClick={onInstall}
          variant="outline"
          size="xs"
          className="rounded-full px-2.5 shadow-none"
        >
          <ExternalLink className="size-3.5" />
          {t('onboarding.toolAddons.browserExtensionInstall')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ToolAddonsScreen({ onNext: _onNext, bucket }: ToolAddonsScreenProps) {
  "use no memo";

  const { t } = useTranslation();
  const [discoveryResult, setDiscoveryResult] = useState<McpDiscoveryResult | null>(null);
  const [installedMcps, setInstalledMcps] = useState<Set<string>>(new Set());
  const [discoveredSetupStates, setDiscoveredSetupStates] = useState<Record<string, ToolSetupState>>({});
  const [isDeepScanning, setIsDeepScanning] = useState(false);
  const [hasCompletedDeepScan, setHasCompletedDeepScan] = useState(false);
  const [deepScanResults, setDeepScanResults] = useState<DiscoveredMcp[]>([]);

  const [storeSetupStates, setStoreSetupStates] = useState<Record<string, ToolSetupState>>({});
  const [storeAddedIds, setStoreAddedIds] = useState<Set<string>>(new Set());
  const [addedServerIds, setAddedServerIds] = useState<Record<string, string>>({});
  const [storePage, setStorePage] = useState(0);
  const [storePageDirection, setStorePageDirection] = useState<1 | -1>(1);
  const [browserStatus, setBrowserStatus] = useState<BrowserControlStatus | null>(null);
  const [browserPolicy, setBrowserPolicy] = useState<BrowserAccessPolicy | null>(null);
  const [browserStatusLoading, setBrowserStatusLoading] = useState(true);
  const [browserPolicyError, setBrowserPolicyError] = useState<string | null>(null);
  const [savingBrowserProfileId, setSavingBrowserProfileId] = useState<string | null>(null);

  const [detailsState, setDetailsState] = useState<DetailsState | null>(null);

  const refreshBrowserStatus = useCallback(async () => {
    setBrowserStatusLoading(true);
    try {
      const [nextStatus, nextPolicy] = await Promise.all([
        browserControl.getStatus(),
        browserControl.getPolicy(),
      ]);
      setBrowserStatus(nextStatus);
      setBrowserPolicy(nextPolicy.policy);
      setBrowserPolicyError(null);
    } catch (error) {
      console.error('[ToolAddonsScreen] Error loading browser extension status:', error);
      trackOnboardingError({
        step: 'tool_addons',
        stage: 'load_browser_extension_status',
        error,
      });
    } finally {
      setBrowserStatusLoading(false);
    }
  }, []);

  const setBrowserProfileSelected = useCallback(async (profile: BrowserControlProfile, selected: boolean) => {
    if (!profile.policyProfileId) {
      return;
    }

    const basePolicy = browserPolicy ?? DEFAULT_BROWSER_ACCESS_POLICY;
    const rule: BrowserAccessRule = {
      mode: selected ? 'ask' : 'deny',
      allowedPatterns: [],
    };
    const nextPolicy = replaceProfilePolicy(basePolicy, profile.policyProfileId, buildProfilePolicy(profile.policyProfileId, rule));

    setSavingBrowserProfileId(profile.policyProfileId);
    setBrowserPolicyError(null);
    try {
      const result = await browserControl.setPolicy(nextPolicy);
      if (!result.success) {
        throw new Error(result.error || t('onboarding.toolAddons.browserExtensionPolicySaveFailed'));
      }
      setBrowserPolicy(result.policy);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('onboarding.toolAddons.browserExtensionPolicySaveFailed');
      console.error('[ToolAddonsScreen] Error saving browser profile selection:', error);
      setBrowserPolicyError(message);
      trackOnboardingError({
        step: 'tool_addons',
        stage: 'save_browser_profile_selection',
        error,
        context: { profileId: profile.policyProfileId, selected },
      });
    } finally {
      setSavingBrowserProfileId(null);
    }
  }, [browserPolicy, t]);

  useEffect(() => {
    void refreshBrowserStatus();
    return browserControl.onChanged?.(() => {
      void refreshBrowserStatus();
    }) ?? undefined;
  }, [refreshBrowserStatus]);

  useEffect(() => {
    let isMounted = true;

    async function loadMcps() {
      try {
        const [importedSetup, existingServers] = await Promise.all([
          typeof mcpDiscovery.importedSetup === 'function'
            ? mcpDiscovery.importedSetup()
            : mcpDiscovery.discover(),
          servers.list(),
        ]);
        const discovered = Array.isArray(importedSetup.candidates)
          ? importedSetup.candidates.map(importedCandidateToDiscoveredMcp)
          : importedSetup.discovered;
        const discovery: McpDiscoveryResult = {
          discovered,
          sources: importedSetup.sources ?? {
            claudeCode: { found: false, path: '' },
            cursor: { found: false, path: '' },
          },
        };

        if (!isMounted) return;
        setDiscoveryResult(discovery);
        void persistDiscoveredMcpSummary(discovery.discovered).catch((error) => {
          console.error('[ToolAddonsScreen] Error persisting discovered tool summary:', error);
          trackOnboardingError({
            step: 'tool_addons',
            stage: 'persist_discovered_tool_summary',
            error,
          });
        });

        const existingServerList = existingServers?.servers || [];
        const installed = new Set<string>(existingServerList.map((server: any) => server.id));
        setInstalledMcps(installed);

        const preAddedStore = new Set<string>();
        for (const entry of MCP_STORE_ENTRIES) {
          const entrySlug = toSlug(entry.name);
          if (installed.has(entry.id) || installed.has(entrySlug)) {
            preAddedStore.add(entry.id);
          }
        }
        setStoreAddedIds(preAddedStore);
      } catch (error) {
        console.error('[ToolAddonsScreen] Error loading discovered tools:', error);
        trackOnboardingError({
          step: 'tool_addons',
          stage: 'load_tools',
          error,
        });
      } finally {
        // noop
      }
    }

    void loadMcps();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleDeepScan = useCallback(async () => {
    if (isDeepScanning || hasCompletedDeepScan) return;
    setIsDeepScanning(true);
    try {
      const result = await mcpDiscovery.deepScan();
      const discovered = result.discovered || [];
      setDeepScanResults(discovered);
      void persistDiscoveredMcpSummary(discovered).catch((error) => {
        console.error('[ToolAddonsScreen] Error persisting deep-scan tool summary:', error);
        trackOnboardingError({
          step: 'tool_addons',
          stage: 'persist_deep_scan_tool_summary',
          error,
        });
      });
      setHasCompletedDeepScan(true);
    } catch (error) {
      console.error('[ToolAddonsScreen] Error during deep scan:', error);
      trackOnboardingError({
        step: 'tool_addons',
        stage: 'deep_scan',
        error,
      });
    } finally {
      setIsDeepScanning(false);
    }
  }, [hasCompletedDeepScan, isDeepScanning]);

  const waitForServerStatus = useCallback((serverId: string, onNeedsAuth: (error?: string) => void): Promise<ToolSetupState> => {
    return new Promise((resolve) => {
      let needsAuthDetected = false;
      let resolved = false;
      const STANDARD_TIMEOUT = 60_000;
      const AUTH_TIMEOUT = 120_000;

      const checkServer = (event: any) => {
        const server = event.servers?.find((candidate: any) => candidate.id === serverId);
        if (!server) return;

        const phase = resolveRemoteToolServerSetupPhase(server.state);

        if (phase === 'needs-auth' && !needsAuthDetected) {
          needsAuthDetected = true;
          onNeedsAuth(server.state?.error);
          clearTimeout(timeoutId);
          timeoutId = window.setTimeout(() => {
            if (resolved) return;
            resolved = true;
            unsubscribe();
            resolve({ phase: 'failed', error: 'Authentication timed out' });
          }, AUTH_TIMEOUT);
          return;
        }

        if (phase === 'connected') {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          unsubscribe();
          resolve({ phase: 'connected' });
          return;
        }

        if (phase === 'failed') {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          unsubscribe();
          resolve({ phase: 'failed', error: server.state?.error || 'Connection failed' });
          return;
        }
      };

      const unsubscribe = toolServers.onChanged((event: any) => {
        const server = event.servers?.find((candidate: any) => candidate.id === serverId);
        console.log(`[onboarding] waitForServerStatus onChanged serverId=${serverId} found=${!!server} status=${server?.state?.status} needsAuth=${server?.state?.needsAuth} serverCount=${event.servers?.length}`);
        checkServer(event);
      });

      toolServers.getSnapshot().then((snapshot: any) => {
        if (snapshot) {
          const server = snapshot.servers?.find((candidate: any) => candidate.id === serverId);
          console.log(`[onboarding] waitForServerStatus snapshotCheck serverId=${serverId} found=${!!server} status=${server?.state?.status} needsAuth=${server?.state?.needsAuth} serverCount=${snapshot.servers?.length}`);
          checkServer(snapshot);
        } else {
          console.log(`[onboarding] waitForServerStatus snapshotCheck serverId=${serverId} snapshot=null`);
        }
      });

      let timeoutId = window.setTimeout(() => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        resolve({ phase: 'failed', error: 'Connection timed out' });
      }, STANDARD_TIMEOUT);
    });
  }, []);

  const handleDiscoveredAdd = useCallback(
    async (mcp: DiscoveredMcp) => {
      const currentState = discoveredSetupStates[mcp.id];
      if (installedMcps.has(mcp.id) || currentState?.phase === 'setting-up' || currentState?.phase === 'needs-auth') {
        return;
      }

      setDiscoveredSetupStates((prev) => ({
        ...prev,
        [mcp.id]: { phase: 'setting-up' },
      }));

      try {
        const result = mcp.startupCandidateId && typeof mcpDiscovery.installImportedCandidate === 'function'
          ? await mcpDiscovery.installImportedCandidate(mcp.startupCandidateId)
          : await addToolServer(buildDiscoveredConfig(mcp));
        const serverId = result?.serverId;
        if (!serverId) {
          throw new Error('No server ID returned');
        }

        if (serverId === 'github') {
          const githubAuth = await providers.addGitHubMcpServerFromCliAuth();
          if (!githubAuth.success) {
            throw new Error(getGitHubCliAuthSetupErrorMessage(githubAuth.error));
          }
        }

        const finalStatus = await waitForServerStatus(serverId, (error) => {
          setDiscoveredSetupStates((prev) => ({
            ...prev,
            [mcp.id]: { phase: 'needs-auth', error },
          }));
          startToolServerOAuth(serverId).then(({ authorizationUrl }) => {
            void openExternal(authorizationUrl);
          }).catch((oauthErr) => {
            console.warn(`[onboarding] OAuth initiation failed serverId=${serverId}`, oauthErr);
            setDiscoveredSetupStates((prev) => ({
              ...prev,
              [mcp.id]: {
                phase: 'failed',
                error: oauthErr instanceof Error ? oauthErr.message : String(oauthErr),
              },
            }));
          });
          if (error) {
            trackOnboardingError({
              step: 'tool_addons',
              stage: 'discovered_tool_needs_auth',
              error,
              context: { serverId, toolId: mcp.id, toolName: mcp.name },
            });
          }
        });

        setDiscoveredSetupStates((prev) => ({
          ...prev,
          [mcp.id]: finalStatus,
        }));

        if (finalStatus.phase === 'failed' && finalStatus.error) {
          trackOnboardingError({
            step: 'tool_addons',
            stage: 'discovered_tool_failed',
            error: finalStatus.error,
            context: { serverId, toolId: mcp.id, toolName: mcp.name },
          });
          trackSkillInstallFailed({
            skillId: mcp.id,
            source: 'discovered',
            error: finalStatus.error,
            stage: 'server_status_failed',
          });
        }

        setAddedServerIds((prev) => ({ ...prev, [mcp.id]: serverId }));

        if (finalStatus.phase === 'connected') {
          setInstalledMcps((prev) => {
            const next = new Set(prev);
            next.add(mcp.id);
            next.add(serverId);
            return next;
          });
          trackSkillInstalled({ skillId: mcp.id, source: 'discovered' });
        }
      } catch (error) {
        console.error(`[ToolAddonsScreen] Error adding discovered tool ${mcp.name}:`, error);
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (isAlreadyExistsError(errorMessage)) {
          setInstalledMcps((prev) => {
            const next = new Set(prev);
            next.add(mcp.id);
            return next;
          });
          setDiscoveredSetupStates((prev) => ({
            ...prev,
            [mcp.id]: { phase: 'connected' },
          }));
          return;
        }

        trackOnboardingError({
          step: 'tool_addons',
          stage: 'add_discovered_tool',
          error,
          displayMessage: errorMessage,
          context: { toolId: mcp.id, toolName: mcp.name },
        });
        trackSkillInstallFailed({
          skillId: mcp.id,
          source: 'discovered',
          error: errorMessage,
          stage: 'add_tool',
        });

        setDiscoveredSetupStates((prev) => ({
          ...prev,
          [mcp.id]: { phase: 'failed', error: errorMessage },
        }));
      }
    },
    [discoveredSetupStates, installedMcps, waitForServerStatus],
  );

  const handleStoreAdd = useCallback(async (entry: McpStoreEntry) => {
    const currentState = storeSetupStates[entry.id];
    if (storeAddedIds.has(entry.id) || currentState?.phase === 'setting-up' || currentState?.phase === 'needs-auth') {
      return;
    }

    setStoreSetupStates((prev) => ({
      ...prev,
      [entry.id]: { phase: 'setting-up' },
    }));

    try {
      const result = entry.id === 'github'
        ? await providers.addGitHubMcpServerFromCliAuth()
        : await addToolServer({
            name: entry.name,
            transport: entry.transport,
            url: entry.url,
            headers: entry.headers || {},
            oauthResource: entry.oauthResource,
            enabled: true,
          });
      const serverId = result?.serverId;
      if (!serverId) {
        if (entry.id === 'github') {
          throw new Error(getGitHubCliAuthSetupErrorMessage((result as { error?: string })?.error));
        }
        throw new Error('No server ID returned');
      }

      const finalStatus = await waitForServerStatus(serverId, (error) => {
        setStoreSetupStates((prev) => ({
          ...prev,
          [entry.id]: { phase: 'needs-auth', error },
        }));
        startToolServerOAuth(serverId).then(({ authorizationUrl }) => {
          void openExternal(authorizationUrl);
        }).catch((oauthErr) => {
          console.warn(`[onboarding] OAuth initiation failed serverId=${serverId}`, oauthErr);
          setStoreSetupStates((prev) => ({
            ...prev,
            [entry.id]: {
              phase: 'failed',
              error: oauthErr instanceof Error ? oauthErr.message : String(oauthErr),
            },
          }));
        });
        if (error) {
          trackOnboardingError({
            step: 'tool_addons',
            stage: 'store_tool_needs_auth',
            error,
            context: { entryId: entry.id, entryName: entry.name, serverId },
          });
        }
      });

      setStoreSetupStates((prev) => ({
        ...prev,
        [entry.id]: finalStatus,
      }));

      if (finalStatus.phase === 'failed' && finalStatus.error) {
        trackOnboardingError({
          step: 'tool_addons',
          stage: 'store_tool_failed',
          error: finalStatus.error,
          context: { entryId: entry.id, entryName: entry.name, serverId },
        });
        trackSkillInstallFailed({
          skillId: entry.id,
          source: 'store',
          error: finalStatus.error,
          stage: 'server_status_failed',
        });
      }

      setAddedServerIds((prev) => ({ ...prev, [entry.id]: serverId }));

      if (finalStatus.phase === 'connected') {
        setStoreAddedIds((prev) => {
          const next = new Set(prev);
          next.add(entry.id);
          return next;
        });
        trackSkillInstalled({ skillId: entry.id, source: 'store' });
      }
    } catch (error) {
      console.error(`[ToolAddonsScreen] Error adding store tool ${entry.name}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isAlreadyExistsError(errorMessage)) {
        setStoreAddedIds((prev) => {
          const next = new Set(prev);
          next.add(entry.id);
          return next;
        });
        setStoreSetupStates((prev) => ({
          ...prev,
          [entry.id]: { phase: 'connected' },
        }));
        return;
      }

      trackOnboardingError({
        step: 'tool_addons',
        stage: 'add_store_tool',
        error,
        displayMessage: errorMessage,
        context: { entryId: entry.id, entryName: entry.name },
      });
      trackSkillInstallFailed({
        skillId: entry.id,
        source: 'store',
        error: errorMessage,
        stage: 'add_tool',
      });

      setStoreSetupStates((prev) => ({
        ...prev,
        [entry.id]: { phase: 'failed', error: errorMessage },
      }));
    }
  }, [storeAddedIds, storeSetupStates, waitForServerStatus]);

  const handleRemove = useCallback(async (entryId: string) => {
    const serverId = addedServerIds[entryId];
    if (!serverId) return;

    setAddedServerIds((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    setInstalledMcps((prev) => {
      const next = new Set(prev);
      next.delete(entryId);
      next.delete(serverId);
      return next;
    });
    setStoreAddedIds((prev) => {
      const next = new Set(prev);
      next.delete(entryId);
      return next;
    });
    setDiscoveredSetupStates((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    setStoreSetupStates((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });

    try {
      await deleteToolServer(serverId);
    } catch (error) {
      console.error(`[ToolAddonsScreen] Failed to remove server ${serverId}:`, error);
    }
  }, [addedServerIds]);

  const allDiscovered = useMemo(() => {
    const merged = [...(discoveryResult?.discovered || []), ...deepScanResults];
    const deduped = new Map<string, DiscoveredMcp>();
    for (const mcp of merged) {
      if (!deduped.has(mcp.id)) deduped.set(mcp.id, mcp);
    }
    return Array.from(deduped.values());
  }, [discoveryResult, deepScanResults]);

  const sortedDiscovered = useMemo(() => {
    return [...allDiscovered].sort((a, b) => {
      const nameRankA = getDiscoveredNameRank(a.name, bucket);
      const nameRankB = getDiscoveredNameRank(b.name, bucket);
      if (nameRankA !== nameRankB) return nameRankA - nameRankB;

      const sourceRankA = getDiscoveredSourceRank(a, bucket);
      const sourceRankB = getDiscoveredSourceRank(b, bucket);
      if (sourceRankA !== sourceRankB) return sourceRankA - sourceRankB;

      return a.name.localeCompare(b.name);
    });
  }, [allDiscovered, bucket]);
  const featuredDiscovered = useMemo(() => sortedDiscovered.slice(0, 3), [sortedDiscovered]);
  const featuredDiscoveredStoreMatches = useMemo(() => {
    const matched = new Set<string>();
    for (const mcp of featuredDiscovered) {
      const match = matchStoreEntryForCandidate({
        id: mcp.id,
        name: mcp.name,
        url: mcp.url,
        command: mcp.command,
        args: mcp.args,
      });
      if (match) {
        matched.add(match.id);
      }
    }
    return matched;
  }, [featuredDiscovered]);

  const sortedStoreEntries = useMemo(() => {
    const manualOrder = STORE_PRIORITY_BY_BUCKET[bucket];
    const orderMap = new Map<string, number>(manualOrder.map((id, index) => [id, index]));
    const entries = bucket === 'non-developer'
      ? MCP_STORE_ENTRIES.filter((entry) => NON_DEVELOPER_STORE_IDS.has(entry.id) && entry.category !== 'developer')
      : MCP_STORE_ENTRIES;

    return [...entries]
      .filter((entry) => !featuredDiscoveredStoreMatches.has(entry.id))
      .sort((a, b) => {
      const rankA = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rankB = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.name.localeCompare(b.name);
    });
  }, [bucket, featuredDiscoveredStoreMatches]);
  const firstPageStoreSlots = useMemo(
    () => Math.max(1, MAX_TOOL_GRID_SLOTS - featuredDiscovered.length - RESERVED_SCAN_SLOT_COUNT - RESERVED_BROWSER_EXTENSION_SLOT_COUNT),
    [featuredDiscovered.length],
  );

  const totalStorePages = useMemo(() => {
    if (sortedStoreEntries.length <= firstPageStoreSlots) {
      return 1;
    }
    return 1 + Math.ceil((sortedStoreEntries.length - firstPageStoreSlots) / MAX_TOOL_GRID_SLOTS);
  }, [firstPageStoreSlots, sortedStoreEntries.length]);

  const isFirstStorePage = storePage === 0;
  const storePageEntries = useMemo(() => {
    if (storePage === 0) {
      return sortedStoreEntries.slice(0, firstPageStoreSlots);
    }

    const start = firstPageStoreSlots + (storePage - 1) * MAX_TOOL_GRID_SLOTS;
    return sortedStoreEntries.slice(start, start + MAX_TOOL_GRID_SLOTS);
  }, [firstPageStoreSlots, sortedStoreEntries, storePage]);
  useEffect(() => {
    const maxPage = totalStorePages - 1;
    if (storePage > maxPage) {
      setStorePage(maxPage);
    }
  }, [storePage, totalStorePages]);

  const goToPreviousStorePage = useCallback(() => {
    setStorePageDirection(-1);
    setStorePage((prev) => Math.max(0, prev - 1));
  }, []);

  const goToNextStorePage = useCallback(() => {
    setStorePageDirection(1);
    setStorePage((prev) => Math.min(totalStorePages - 1, prev + 1));
  }, [totalStorePages]);

  return (
    <OnboardingScreenShell size="wide" align="center" className="py-3 sm:py-4" contentClassName="max-w-[820px]">
      <div className="w-full space-y-4">
        <OnboardingHeading
          title={t('onboarding.toolAddons.title')}
          description="Connect Interpreter to your other applications."
        />

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {totalStorePages > 1 ? (
              <Button
                type="button"
                onClick={goToPreviousStorePage}
                disabled={storePage === 0}
                variant="outline"
                size="icon-sm"
                className="shrink-0 rounded-full border-[color-mix(in_oklch,var(--oa-border)_72%,transparent)] bg-[color-mix(in_oklch,var(--oa-bg-app)_82%,var(--oa-bg-subtle)_18%)] text-[var(--oa-text)] shadow-none hover:border-[var(--oa-border-strong)] hover:bg-[var(--oa-bg-hover)]"
                aria-label={t('onboarding.toolAddons.previous')}
              >
                <ChevronLeft className="size-4" />
              </Button>
            ) : (
              <div className="size-7 shrink-0" aria-hidden="true" />
            )}

            <div className="min-w-0 flex-1">
              <AnimatePresence mode="wait" initial={false} custom={storePageDirection}>
                <motion.div
                  key={`tools-page-${storePage}`}
                  custom={storePageDirection}
                  variants={STORE_PAGE_VARIANTS}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3"
                >
                  {isFirstStorePage && (
                    <BrowserExtensionSetupCard
                      status={browserStatus}
                      policy={browserPolicy}
                      loading={browserStatusLoading}
                      savingProfileId={savingBrowserProfileId}
                      error={browserPolicyError}
                      onInstall={() => {
                        void openExternal(CHROME_EXTENSION_INSTALL_URL);
                      }}
                      onRefresh={() => {
                        void refreshBrowserStatus();
                      }}
                      onSetProfileSelected={(profile, selected) => {
                        void setBrowserProfileSelected(profile, selected);
                      }}
                    />
                  )}

                  {isFirstStorePage && featuredDiscovered.map((mcp) => {
                    const setupState = discoveredSetupStates[mcp.id];
                    const isInstalled = installedMcps.has(mcp.id) || setupState?.phase === 'connected';
                    return (
                      <OnboardingStoreCard
                        key={mcp.id}
                        icon={getDiscoveredFaviconUrl(mcp) ? (
                          <img
                            src={getDiscoveredFaviconUrl(mcp)!}
                            alt=""
                            className="size-5 rounded-sm"
                            loading="lazy"
                          />
                        ) : (
                          <Plug className="size-5 text-[var(--oa-text-muted)]" />
                        )}
                        title={mcp.name}
                        description={getDiscoveredSummary(mcp, bucket)}
                        tone="discovered"
                        setupState={setupState}
                        isAdded={isInstalled}
                        badgeLabel="Found on this computer"
                        addLabel={t('onboarding.toolAddons.add')}
                        removeLabel={t('onboarding.toolAddons.remove', 'Remove')}
                        completeInBrowserLabel={t('onboarding.toolAddons.completeInBrowser')}
                        detailsLabel={t('onboarding.toolAddons.details')}
                        onAdd={() => {
                          void handleDiscoveredAdd(mcp);
                        }}
                        onRemove={() => void handleRemove(mcp.id)}
                        onDetails={() => setDetailsState({ kind: 'discovered', entry: mcp })}
                      />
                    );
                  })}

                  {storePageEntries.map((entry) => {
                    const setupState = storeSetupStates[entry.id];
                    const isAdded = storeAddedIds.has(entry.id) || setupState?.phase === 'connected';
                    return (
                      <OnboardingStoreCard
                        key={entry.id}
                        icon={(
                          <img
                            src={getFaviconUrl(entry.domain)}
                            alt=""
                            className="size-5 rounded-sm"
                            loading="lazy"
                          />
                        )}
                        title={entry.name}
                        description={entry.description}
                        setupState={setupState}
                        isAdded={isAdded}
                        badgeLabel={t(STORE_CATEGORY_KEYS[entry.category])}
                        addLabel={t('onboarding.toolAddons.add')}
                        removeLabel={t('onboarding.toolAddons.remove', 'Remove')}
                        completeInBrowserLabel={t('onboarding.toolAddons.completeInBrowser')}
                        detailsLabel={t('onboarding.toolAddons.details')}
                        onAdd={() => {
                          void handleStoreAdd(entry);
                        }}
                        onRemove={() => void handleRemove(entry.id)}
                        onDetails={() => setDetailsState({ kind: 'store', entry })}
                      />
                    );
                  })}

                  {isFirstStorePage && (
                    <div
                      className="flex h-full min-h-[132px] flex-col justify-between rounded-[16px] px-4 py-3"
                      style={{
                        border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 40%, transparent)',
                        backgroundColor: 'color-mix(in oklch, var(--oa-bg-subtle) 34%, var(--oa-bg-app) 66%)',
                      }}
                    >
                      <div className="space-y-1.5">
                        <h4 className="text-[14px] font-medium text-[var(--oa-text-strong)]">
                          {hasCompletedDeepScan ? 'Scan complete' : 'Scan computer for more tools'}
                        </h4>
                        <p className="text-[12px] leading-5 text-[var(--oa-text-muted)]">
                          Search this computer for more available integrations.
                        </p>
                      </div>

                      <div className="mt-3 flex justify-end">
                        <Button
                          type="button"
                          onClick={handleDeepScan}
                          disabled={isDeepScanning || hasCompletedDeepScan}
                          variant="secondary"
                          size="sm"
                          className="rounded-full px-3 shadow-none"
                        >
                          {isDeepScanning ? <Loader2 className="size-3.5 animate-spin" /> : hasCompletedDeepScan ? <Check className="size-3.5" /> : null}
                          {isDeepScanning ? t('onboarding.toolAddons.pleaseWait') : hasCompletedDeepScan ? 'Scan complete' : 'Scan computer'}
                        </Button>
                      </div>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            {totalStorePages > 1 ? (
              <Button
                type="button"
                onClick={goToNextStorePage}
                disabled={storePage >= totalStorePages - 1}
                variant="outline"
                size="icon-sm"
                className="shrink-0 rounded-full border-[color-mix(in_oklch,var(--oa-border)_72%,transparent)] bg-[color-mix(in_oklch,var(--oa-bg-app)_82%,var(--oa-bg-subtle)_18%)] text-[var(--oa-text)] shadow-none hover:border-[var(--oa-border-strong)] hover:bg-[var(--oa-bg-hover)]"
                aria-label={t('onboarding.toolAddons.next')}
              >
                <ChevronRight className="size-4" />
              </Button>
            ) : (
              <div className="size-7 shrink-0" aria-hidden="true" />
            )}
          </div>
        </div>
      </div>

      <OnboardingModal
        open={detailsState !== null}
        onClose={() => setDetailsState(null)}
        panelClassName="max-w-md space-y-4 rounded-[24px] p-6"
        panelStyle={MODAL_STYLE}
      >
        {detailsState && (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                {detailsState.kind === 'store' ? (
                  <img
                    src={getFaviconUrl(detailsState.entry.domain, 128)}
                    alt=""
                    className="size-10 rounded-control shrink-0"
                    loading="lazy"
                  />
                ) : getDiscoveredFaviconUrl(detailsState.entry) ? (
                  <img
                    src={getDiscoveredFaviconUrl(detailsState.entry)!}
                    alt=""
                    className="size-10 rounded-control shrink-0"
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="flex size-10 items-center justify-center rounded-control shrink-0"
                    style={{
                      ...BADGE_STYLE,
                      backgroundColor: 'color-mix(in oklch, var(--oa-bg-subtle) 76%, var(--oa-bg-app) 24%)',
                    }}
                  >
                    <Plug className="size-5 text-muted-foreground" />
                  </div>
                )}

                <div className="min-w-0">
                  <h3 className="truncate text-lg font-medium text-[var(--oa-text-strong)]">
                    {detailsState.kind === 'store' ? detailsState.entry.name : detailsState.entry.name}
                  </h3>
                  <p className="text-sm text-[var(--oa-text-muted)]">
                    {detailsState.kind === 'store'
                      ? detailsState.entry.description
                      : t('onboarding.toolAddons.discoveredOnComputer')}
                  </p>
                </div>
              </div>

              <button
                onClick={() => setDetailsState(null)}
                className="p-1 text-[var(--oa-text-muted)] transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="space-y-2 text-sm text-[var(--oa-text-muted)]">
              {detailsState.kind === 'store' ? (
                <>
                  <p>{t('onboarding.toolAddons.transportLabel', { transport: detailsState.entry.transport.toUpperCase() })}</p>
                  {detailsState.entry.note && (
                    <p className="text-xs italic">{detailsState.entry.note}</p>
                  )}
                  <p>{t('onboarding.toolAddons.authAutomatic')}</p>
                </>
              ) : (
                <>
                  <p>{t('onboarding.toolAddons.connectionDetails')}</p>
                  <p className="break-all text-xs">
                    {getDiscoveredDetailsPreview(detailsState.entry)}
                  </p>
                </>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              {detailsState.kind === 'store' ? (
                <>
                  {(storeAddedIds.has(detailsState.entry.id) || storeSetupStates[detailsState.entry.id]?.phase === 'connected') ? (
                    <div className="flex items-center gap-2 text-sm text-emerald-500">
                      <Check className="size-4" />
                      {t('onboarding.toolAddons.added')}
                    </div>
                  ) : storeSetupStates[detailsState.entry.id]?.phase === 'needs-auth' ? (
                    <div className="flex items-center gap-2 text-sm text-primary">
                      <Loader2 className="size-4 animate-spin" />
                      {t('onboarding.toolAddons.completeAuthInBrowser')}
                    </div>
                  ) : (
                    <Button
                      type="button"
                      onClick={() => {
                        void handleStoreAdd(detailsState.entry);
                      }}
                      disabled={storeSetupStates[detailsState.entry.id]?.phase === 'setting-up'}
                      className="rounded-full px-4"
                    >
                      {storeSetupStates[detailsState.entry.id]?.phase === 'setting-up' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      {t('onboarding.toolAddons.addToInterpreter')}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  {(installedMcps.has(detailsState.entry.id) || discoveredSetupStates[detailsState.entry.id]?.phase === 'connected') ? (
                    <div className="flex items-center gap-2 text-sm text-emerald-500">
                      <Check className="size-4" />
                      {t('onboarding.toolAddons.added')}
                    </div>
                  ) : discoveredSetupStates[detailsState.entry.id]?.phase === 'needs-auth' ? (
                    <div className="flex items-center gap-2 text-sm text-primary">
                      <Loader2 className="size-4 animate-spin" />
                      {t('onboarding.toolAddons.completeAuthInBrowser')}
                    </div>
                  ) : (
                    <Button
                      type="button"
                      onClick={() => {
                        void handleDiscoveredAdd(detailsState.entry);
                      }}
                      disabled={discoveredSetupStates[detailsState.entry.id]?.phase === 'setting-up'}
                      className="rounded-full px-4"
                    >
                      {discoveredSetupStates[detailsState.entry.id]?.phase === 'setting-up' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      {t('onboarding.toolAddons.addToInterpreter')}
                    </Button>
                  )}
                </>
              )}

              {detailsState.kind === 'store' && storeSetupStates[detailsState.entry.id]?.phase === 'failed' && (
                <p className="text-xs text-destructive">
                  {storeSetupStates[detailsState.entry.id]?.error || t('onboarding.toolAddons.connectionFailed')}
                </p>
              )}
              {detailsState.kind === 'store' && storeSetupStates[detailsState.entry.id]?.phase === 'needs-auth' && storeSetupStates[detailsState.entry.id]?.error && (
                <p className="text-xs text-primary">
                  {storeSetupStates[detailsState.entry.id]?.error}
                </p>
              )}
              {detailsState.kind === 'discovered' && discoveredSetupStates[detailsState.entry.id]?.phase === 'failed' && (
                <p className="text-xs text-destructive">
                  {discoveredSetupStates[detailsState.entry.id]?.error || t('onboarding.toolAddons.connectionFailed')}
                </p>
              )}
              {detailsState.kind === 'discovered' && discoveredSetupStates[detailsState.entry.id]?.phase === 'needs-auth' && discoveredSetupStates[detailsState.entry.id]?.error && (
                <p className="text-xs text-primary">
                  {discoveredSetupStates[detailsState.entry.id]?.error}
                </p>
              )}

              <Button
                type="button"
                onClick={() => setDetailsState(null)}
                variant="outline"
                className="rounded-full px-4 text-[var(--oa-text-muted)]"
              >
                {t('onboarding.toolAddons.close')}
              </Button>
            </div>
          </div>
        )}
      </OnboardingModal>
    </OnboardingScreenShell>
  );
}
