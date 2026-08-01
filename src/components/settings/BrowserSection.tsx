import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { browserControl, openExternal } from '@/ipc';
import { trackSettingChanged } from '@/utils/telemetry';
import { logUserVisibleError } from '@/utils/userVisibleErrorLog';
import {
  BROWSER_ACCESS_PERMISSION_KINDS,
  DEFAULT_BROWSER_ACCESS_POLICY,
  getBrowserAccessProfilePolicy,
  normalizeBrowserAccessPattern,
  type BrowserAccessPolicy,
  type BrowserAccessPermissionKind,
  type BrowserAccessProfilePolicy,
  type BrowserAccessRule,
} from '../../../shared/browserAccessPolicy';
import type {
  BrowserControlChangedEvent,
  BrowserControlConnection,
  BrowserControlProfile,
  BrowserControlStatus,
} from '../../../shared/types/browserControl';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { NativeSelect } from '../ui/NativeSelect';
import {
  SettingsCard,
  SettingsPane,
  SettingsRow,
  SettingsSection,
} from './SettingsSection';

const CHROME_EXTENSION_INSTALL_URL = 'https://chromewebstore.google.com/detail/interpreter-chrome-extens/bboaaphdpllilofamfpommlbafpellnb';
const TARGET_PREVIEW_LIMIT = 4;
const EMPTY_VALUE = '--';
const DEFAULT_PROFILE_MODE_VALUE = '__default__';

const BROWSER_ACCESS_PERMISSION_LABEL_KEYS: Record<BrowserAccessPermissionKind, string> = {
  read: 'settings.browser.policy.permissionRead',
  write: 'settings.browser.policy.permissionWrite',
  action: 'settings.browser.policy.permissionAction',
};

function formatBrowserName(browserName: string | null, fallback: string): string {
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
      return browserName?.trim() || fallback;
  }
}

function formatTargetTitle(target: BrowserControlConnection['targets'][number], fallback: string): string {
  if (target.title.trim().length > 0) {
    return target.title;
  }

  if (target.url.trim().length > 0) {
    try {
      return new URL(target.url).hostname || target.url;
    } catch {
      return target.url;
    }
  }

  return fallback;
}

function formatTargetSubtitle(
  target: BrowserControlConnection['targets'][number],
  fallback: string,
): string {
  if (target.url.trim().length > 0) {
    try {
      const url = new URL(target.url);
      return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      return target.url;
    }
  }

  return fallback;
}

function getBrowserAccessBadge(relay: BrowserControlStatus['relay']) {
  if (relay.reachable) {
    return {
      labelKey: 'settings.browser.status.online',
      variant: 'default' as const,
    };
  }

  if (relay.phase === 'starting') {
    return {
      labelKey: 'settings.browser.status.starting',
      variant: 'secondary' as const,
    };
  }

  if (relay.phase === 'error') {
    return {
      labelKey: 'settings.browser.status.unavailable',
      variant: 'destructive' as const,
    };
  }

  return {
    labelKey: 'settings.browser.status.notRunning',
    variant: 'outline' as const,
  };
}

function getBrowserIssueCard(
  relay: BrowserControlStatus['relay'] | null,
  loadError: string | null,
) {
  if (loadError || relay?.phase === 'error') {
    return {
      tone: 'danger' as const,
      titleKey: 'settings.browser.issue.unavailableTitle',
      descriptionKey: 'settings.browser.issue.unavailableDescription',
    };
  }

  if (relay?.phase === 'starting') {
    return {
      tone: 'muted' as const,
      titleKey: 'settings.browser.issue.startingTitle',
      descriptionKey: 'settings.browser.issue.startingDescription',
    };
  }

  return null;
}

function getSessionCountLabel(count: number, t: ReturnType<typeof useTranslation>['t']): string {
  return count === 1
    ? t('settings.browser.connection.oneSession')
    : t('settings.browser.connection.manySessions', { count });
}

function getBrowserProfileId(connection: BrowserControlConnection): string {
  return connection.profileId;
}

function getBrowserProfileDisplayLabel(
  profile: BrowserControlProfile,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const browserName = formatBrowserName(profile.browserName, t('settings.browser.connection.fallbackName'));
  return `${browserName} ${profile.profileName}`;
}

function browserProfilesFromConnections(
  connections: BrowserControlConnection[],
): BrowserControlProfile[] {
  return connections.map((connection) => {
    const profileId = getBrowserProfileId(connection);
    return {
      profileId,
      policyProfileId: profileId,
      browserName: connection.browserName,
      browserChannel: null,
      profileName: connection.stableKey ?? connection.extensionId,
      profilePath: '',
      userDataDir: '',
      extensionId: connection.extensionId,
      stableKey: connection.stableKey,
      connectionState: 'connected',
      activeSessions: connection.activeSessions,
      windowCount: connection.browserWindows.length,
      tabCount: connection.browserWindows.reduce((count, window) => count + window.tabs.length, 0),
    };
  });
}

function getPatternError(pattern: string): string | null {
  if (pattern.trim().length === 0) {
    return null;
  }

  try {
    normalizeBrowserAccessPattern(pattern);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function normalizeDraftPatterns(patterns: string[]): string[] {
  return Array.from(
    new Set(
      patterns
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)
        .map((pattern) => normalizeBrowserAccessPattern(pattern)),
    ),
  );
}

function hasInvalidPatterns(patterns: string[]): boolean {
  return patterns.some((pattern) => getPatternError(pattern) !== null);
}

function replaceProfilePolicy(
  policy: BrowserAccessPolicy,
  profileId: string,
  nextProfilePolicy: BrowserAccessProfilePolicy | null,
): BrowserAccessPolicy {
  const profilePolicies = policy.profilePolicies.filter((profilePolicy) => profilePolicy.profileId !== profileId);
  if (nextProfilePolicy) {
    profilePolicies.push(nextProfilePolicy);
  }

  return {
    ...policy,
    profilePolicies,
  };
}

function replacePolicyRule(
  policy: BrowserAccessPolicy,
  permissionKind: BrowserAccessPermissionKind,
  nextRule: BrowserAccessRule,
): BrowserAccessPolicy {
  return {
    ...policy,
    permissions: {
      ...policy.permissions,
      [permissionKind]: nextRule,
    },
  };
}

function replaceProfilePolicyRule(
  profilePolicy: BrowserAccessProfilePolicy,
  permissionKind: BrowserAccessPermissionKind,
  nextRule: BrowserAccessRule,
): BrowserAccessProfilePolicy {
  return {
    ...profilePolicy,
    permissions: {
      ...profilePolicy.permissions,
      [permissionKind]: nextRule,
    },
  };
}

function buildDefaultProfilePolicy(profileId: string, basePolicy: BrowserAccessPolicy): BrowserAccessProfilePolicy {
  return {
    profileId,
    permissions: basePolicy.permissions,
  };
}

export function BrowserSectionContent() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BrowserControlStatus | null>(null);
  const [policy, setPolicy] = useState<BrowserAccessPolicy>(DEFAULT_BROWSER_ACCESS_POLICY);
  const [draftPatterns, setDraftPatterns] = useState<Record<BrowserAccessPermissionKind, string[]>>({
    read: [],
    write: [],
    action: [],
  });
  const [profileDraftPatterns, setProfileDraftPatterns] = useState<Record<string, Record<BrowserAccessPermissionKind, string[]>>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [showPolicyRefreshHint, setShowPolicyRefreshHint] = useState(false);
  const requestIdRef = useRef(0);

  const applyLoadedPolicy = useCallback((nextPolicy: BrowserAccessPolicy) => {
    setPolicy(nextPolicy);
    setDraftPatterns({
      read: nextPolicy.permissions.read.allowedPatterns,
      write: nextPolicy.permissions.write.allowedPatterns,
      action: nextPolicy.permissions.action.allowedPatterns,
    });
    setProfileDraftPatterns(Object.fromEntries(
      nextPolicy.profilePolicies.map((profilePolicy) => [
        profilePolicy.profileId,
        {
          read: profilePolicy.permissions.read.allowedPatterns,
          write: profilePolicy.permissions.write.allowedPatterns,
          action: profilePolicy.permissions.action.allowedPatterns,
        },
      ]),
    ));
    setPolicyError(null);
  }, []);

  const refreshAll = useCallback(async (background = false) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (background) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const [nextStatus, nextPolicy] = await Promise.all([
        browserControl.getStatus(),
        browserControl.getPolicy(),
      ]);
      if (requestId !== requestIdRef.current) {
        return;
      }

      setStatus(nextStatus);
      applyLoadedPolicy(nextPolicy.policy);
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : t('settings.browser.loadErrorFallback');
      logUserVisibleError('settings', {
        message,
        details: 'Browser settings failed to load browser-control state.',
      });
      setLoadError(message);
    }

    if (requestId !== requestIdRef.current) {
      return;
    }

    setLoading(false);
    setRefreshing(false);
  }, [applyLoadedPolicy, t]);

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await browserControl.getStatus();
      setStatus(nextStatus);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.browser.loadErrorFallback');
      logUserVisibleError('settings', {
        message,
        details: 'Browser settings failed to refresh browser-control status.',
      });
      setLoadError(message);
    }
  }, [t]);

  const savePolicy = useCallback(async (nextPolicy: BrowserAccessPolicy) => {
    setSavingPolicy(true);
    const previousPolicy = policy;

    let result: Awaited<ReturnType<typeof browserControl.setPolicy>>;
    try {
      result = await browserControl.setPolicy(nextPolicy);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.browser.policy.saveErrorFallback');
      setShowPolicyRefreshHint(false);
      setPolicyError(message);
      setSavingPolicy(false);
      throw error;
    }

    if (!result.success) {
      const message = result.error || t('settings.browser.policy.saveErrorFallback');
      setShowPolicyRefreshHint(false);
      setPolicyError(message);
      setSavingPolicy(false);
      throw new Error(message);
    }

    applyLoadedPolicy(result.policy);
    setPolicyError(null);
    setShowPolicyRefreshHint(true);
    trackSettingChanged({
      settingKey: 'browserAccessPolicy',
      tabId: 'browser',
      sectionId: 'browser',
      valueType: 'object',
      oldValue: JSON.stringify(previousPolicy),
      newValue: JSON.stringify(result.policy),
    });
    setSavingPolicy(false);
    return result.policy;
  }, [applyLoadedPolicy, policy, t]);

  const commitDraftPatterns = useCallback(async (
    permissionKind: BrowserAccessPermissionKind,
    nextDraftPatterns: string[],
  ) => {
    if (hasInvalidPatterns(nextDraftPatterns)) {
      setPolicyError(t('settings.browser.policy.invalidRules'));
      return;
    }

    const allowedPatterns = normalizeDraftPatterns(nextDraftPatterns);
    try {
      await savePolicy(replacePolicyRule(policy, permissionKind, {
        ...policy.permissions[permissionKind],
        allowedPatterns,
      }));
    } catch {
      // savePolicy already updates the visible error state
    }
  }, [policy, savePolicy, t]);

  const commitProfileDraftPatterns = useCallback(async (
    profileId: string,
    permissionKind: BrowserAccessPermissionKind,
    nextDraftPatterns: string[],
  ) => {
    if (hasInvalidPatterns(nextDraftPatterns)) {
      setPolicyError(t('settings.browser.policy.invalidRules'));
      return;
    }

    const existingProfilePolicy = getBrowserAccessProfilePolicy(policy, profileId);
    const nextProfilePolicy = existingProfilePolicy ?? buildDefaultProfilePolicy(profileId, policy);
    const allowedPatterns = normalizeDraftPatterns(nextDraftPatterns);
    try {
      await savePolicy(replaceProfilePolicy(policy, profileId, replaceProfilePolicyRule(
        nextProfilePolicy,
        permissionKind,
        {
          ...nextProfilePolicy.permissions[permissionKind],
          allowedPatterns,
        },
      )));
    } catch {
      // savePolicy already updates the visible error state
    }
  }, [policy, savePolicy, t]);

  useEffect(() => {
    void refreshAll(false);
  }, [refreshAll]);

  useEffect(() => {
    const handleFocus = () => {
      void refreshStatus();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshStatus();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!browserControl.onChanged) {
      return;
    }

    return browserControl.onChanged((event: BrowserControlChangedEvent) => {
      if (event.reason === 'policy') {
        applyLoadedPolicy(event.policy);
      }
      void refreshStatus();
    });
  }, [applyLoadedPolicy, refreshStatus]);

  const relay = status?.relay ?? null;
  const browserAccessBadge = relay ? getBrowserAccessBadge(relay) : null;
  const connections = status?.connections ?? [];
  const browserProfiles = (status?.profiles ?? []).length > 0
    ? status!.profiles
    : browserProfilesFromConnections(connections);
  const issueCard = getBrowserIssueCard(relay, loadError);
  const insetCardStyle = {
    borderWidth: 'var(--border-width)',
    borderColor: 'color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)',
  } as const;

  const connectionDescriptionKey = policy.permissions.read.mode === 'allowList'
    ? 'settings.browser.connectionsRestrictedDescription'
    : policy.permissions.read.mode === 'ask'
      ? 'settings.browser.connectionsAskDescription'
      : policy.permissions.read.mode === 'deny'
        ? 'settings.browser.connectionsDenyDescription'
      : 'settings.browser.connectionsDescription';

  return (
    <SettingsPane>
      <SettingsSection
        title={t('settings.browser.heroTitle')}
        description={t('settings.browser.heroDescription')}
        sectionId="browser"
      >
        <div className="space-y-5 py-[18px]">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              data-icon="inline-end"
              className="shrink-0 bg-foreground text-background hover:bg-foreground/90"
              onClick={() => {
                void openExternal(CHROME_EXTENSION_INSTALL_URL);
              }}
            >
              {t('settings.browser.actions.install')}
              <ExternalLink className="size-4" />
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              data-icon="inline-start"
              className="shrink-0"
              disabled={loading || refreshing}
              onClick={() => {
                void refreshAll(true);
              }}
            >
              {loading || refreshing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t(loading || refreshing ? 'settings.browser.actions.refreshing' : 'settings.browser.actions.refresh')}
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SettingsCard
              tone="muted"
              className="rounded-[14px] px-3.5 py-3"
              style={insetCardStyle}
            >
              <p className="text-ui-xs font-medium text-muted-foreground">
                {t('settings.browser.metrics.access')}
              </p>
              <div className="mt-2 flex min-h-6 items-center gap-2">
                {browserAccessBadge ? (
                  <Badge variant={browserAccessBadge.variant}>
                    {t(browserAccessBadge.labelKey)}
                  </Badge>
                ) : (
                  <span className="text-ui-sm text-muted-foreground">
                    {t('settings.browser.status.checking')}
                  </span>
                )}
              </div>
            </SettingsCard>

            <SettingsCard
              tone="muted"
              className="rounded-[14px] px-3.5 py-3"
              style={insetCardStyle}
            >
              <p className="text-ui-xs font-medium text-muted-foreground">
                {t('settings.browser.metrics.connectedBrowsers')}
              </p>
              <p className="mt-2 text-[20px] font-medium tracking-[-0.02em] text-foreground tabular-nums">
                {status ? status.connectedBrowsers : EMPTY_VALUE}
              </p>
            </SettingsCard>

            <SettingsCard
              tone="muted"
              className="rounded-[14px] px-3.5 py-3"
              style={insetCardStyle}
            >
              <p className="text-ui-xs font-medium text-muted-foreground">
                {t('settings.browser.metrics.activeSessions')}
              </p>
              <p className="mt-2 text-[20px] font-medium tracking-[-0.02em] text-foreground tabular-nums">
                {status ? status.activeSessions : EMPTY_VALUE}
              </p>
            </SettingsCard>
          </div>

          <p className="max-w-2xl text-ui-xs leading-5 text-muted-foreground text-pretty">
            {t('settings.browser.optionalNote')}
          </p>

          {issueCard ? (
            <SettingsCard tone={issueCard.tone}>
              <p className="text-ui-sm font-medium text-foreground">
                {t(issueCard.titleKey)}
              </p>
              <p className="mt-1 text-ui-sm leading-6 text-muted-foreground text-pretty">
                {t(issueCard.descriptionKey)}
              </p>
            </SettingsCard>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.browser.policy.title')}
        description={t('settings.browser.policy.description')}
      >
        {BROWSER_ACCESS_PERMISSION_KINDS.map((permissionKind) => (
          <SettingsRow
            key={permissionKind}
            label={t(BROWSER_ACCESS_PERMISSION_LABEL_KEYS[permissionKind])}
            description={t(`settings.browser.policy.permission${permissionKind[0].toUpperCase()}${permissionKind.slice(1)}Description`)}
            align="start"
          >
            <NativeSelect
              value={policy.permissions[permissionKind].mode}
              disabled={savingPolicy}
              onValueChange={(value) => {
                const nextMode = value as BrowserAccessRule['mode'];
                const currentPatterns = draftPatterns[permissionKind];
                const nextDraftPatterns = nextMode === 'allowList' && currentPatterns.length === 0
                  ? ['']
                  : currentPatterns;
                setDraftPatterns((current) => ({
                  ...current,
                  [permissionKind]: nextDraftPatterns,
                }));
                setShowPolicyRefreshHint(false);
                void savePolicy(replacePolicyRule(policy, permissionKind, {
                  mode: nextMode,
                  allowedPatterns: policy.permissions[permissionKind].allowedPatterns,
                })).catch(() => {});
              }}
              items={[
                { label: t('settings.browser.policy.modeAsk'), value: 'ask' },
                { label: t('settings.browser.policy.modeDeny'), value: 'deny' },
                { label: t('settings.browser.policy.modeAll'), value: 'all' },
                { label: t('settings.browser.policy.modeRestricted'), value: 'allowList' },
              ]}
              size="sm"
              className="w-full sm:min-w-[260px]"
            />
          </SettingsRow>
        ))}

        {browserProfiles.length > 0 ? (
          <div className="space-y-3 py-[18px]">
            <div className="space-y-1">
              <p className="text-ui-sm font-medium text-foreground">
                {t('settings.browser.policy.profilesTitle')}
              </p>
              <p className="text-ui-sm leading-6 text-muted-foreground text-pretty">
                {t('settings.browser.policy.profilesDescription')}
              </p>
            </div>

            <div className="space-y-3">
              {browserProfiles.map((profile) => {
                const policyProfileId = profile.policyProfileId;
                const profilePolicy = policyProfileId
                  ? getBrowserAccessProfilePolicy(policy, policyProfileId)
                  : null;
                const profileLabel = getBrowserProfileDisplayLabel(profile, t);
                const windows = profile.windowCount;
                const tabs = profile.tabCount;

                return (
                  <SettingsCard
                    key={profile.profileId}
                    tone="muted"
                    className="rounded-[14px]"
                    style={insetCardStyle}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <p className="truncate text-ui-sm font-medium text-foreground">
                            {profileLabel}
                          </p>
                          <Badge variant={profile.connectionState === 'connected' ? 'default' : 'outline'}>
                            {t(profile.connectionState === 'connected'
                              ? 'settings.browser.policy.profileConnected'
                              : 'settings.browser.policy.profileDetected')}
                          </Badge>
                        </div>
                        <p className="text-ui-xs leading-5 text-muted-foreground text-pretty">
                          {policyProfileId
                            ? t('settings.browser.policy.profileInventory', { windows, tabs })
                            : t('settings.browser.policy.profileNotConnected')}
                        </p>
                        {profile.profilePath ? (
                          <p className="truncate text-ui-xs leading-5 text-muted-foreground">
                            {t('settings.browser.policy.profilePath', { path: profile.profilePath })}
                          </p>
                        ) : null}
                      </div>
                      {!policyProfileId ? (
                        <Badge variant="outline">
                          {t('settings.browser.policy.profilePermissionUnavailable')}
                        </Badge>
                      ) : null}
                    </div>

                    {policyProfileId ? (
                      <div className="mt-3 space-y-4">
                        {BROWSER_ACCESS_PERMISSION_KINDS.map((permissionKind) => {
                          const profileModeValue = profilePolicy?.permissions[permissionKind].mode ?? DEFAULT_PROFILE_MODE_VALUE;
                          const profilePatterns = profileDraftPatterns[policyProfileId]?.[permissionKind]
                            ?? profilePolicy?.permissions[permissionKind].allowedPatterns
                            ?? [];

                          return (
                            <div key={`${policyProfileId}-${permissionKind}`} className="space-y-3">
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <p className="text-ui-xs font-medium text-muted-foreground">
                                  {t(BROWSER_ACCESS_PERMISSION_LABEL_KEYS[permissionKind])}
                                </p>
                                <NativeSelect
                                  value={profileModeValue}
                                  disabled={savingPolicy}
                                  onValueChange={(value) => {
                                    setShowPolicyRefreshHint(false);
                                    const nextProfilePolicy = profilePolicy ?? buildDefaultProfilePolicy(policyProfileId, policy);
                                    if (value === DEFAULT_PROFILE_MODE_VALUE) {
                                      if (!profilePolicy) {
                                        return;
                                      }
                                      const nextPermissions = {
                                        ...profilePolicy.permissions,
                                        [permissionKind]: policy.permissions[permissionKind],
                                      };
                                      const shouldRemovePolicy = BROWSER_ACCESS_PERMISSION_KINDS.every((kind) => (
                                        nextPermissions[kind].mode === policy.permissions[kind].mode
                                          && nextPermissions[kind].allowedPatterns.join('\n') === policy.permissions[kind].allowedPatterns.join('\n')
                                      ));
                                      void savePolicy(replaceProfilePolicy(
                                        policy,
                                        policyProfileId,
                                        shouldRemovePolicy ? null : {
                                          ...profilePolicy,
                                          permissions: nextPermissions,
                                        },
                                      )).catch(() => {});
                                      return;
                                    }

                                    const mode = value as BrowserAccessRule['mode'];
                                    const allowedPatterns = mode === 'allowList'
                                      ? normalizeDraftPatterns(profilePatterns)
                                      : nextProfilePolicy.permissions[permissionKind].allowedPatterns;
                                    if (mode === 'allowList' && profilePatterns.length === 0) {
                                      setProfileDraftPatterns((currentPatterns) => ({
                                        ...currentPatterns,
                                        [policyProfileId]: {
                                          ...(currentPatterns[policyProfileId] ?? { read: [], write: [], action: [] }),
                                          [permissionKind]: [''],
                                        },
                                      }));
                                    }
                                    void savePolicy(replaceProfilePolicy(policy, policyProfileId, replaceProfilePolicyRule(
                                      nextProfilePolicy,
                                      permissionKind,
                                      { mode, allowedPatterns },
                                    ))).catch(() => {});
                                  }}
                                  items={[
                                    { label: t('settings.browser.policy.profileModeDefault'), value: DEFAULT_PROFILE_MODE_VALUE },
                                    { label: t('settings.browser.policy.modeAsk'), value: 'ask' },
                                    { label: t('settings.browser.policy.modeDeny'), value: 'deny' },
                                    { label: t('settings.browser.policy.modeAll'), value: 'all' },
                                    { label: t('settings.browser.policy.modeRestricted'), value: 'allowList' },
                                  ]}
                                  size="sm"
                                  className="w-full sm:min-w-[220px]"
                                />
                              </div>

                              {profileModeValue === 'allowList' ? (
                                <div className="space-y-3">
                                  {(profilePatterns.length > 0 ? profilePatterns : ['']).map((pattern, index) => {
                                    const patternError = getPatternError(pattern);
                                    return (
                                      <div key={`${policyProfileId}-${permissionKind}-page-rule-${index}`} className="space-y-2">
                                        <div className="flex items-start gap-2">
                                          <Input
                                            value={pattern}
                                            disabled={savingPolicy}
                                            placeholder={t('settings.browser.policy.rulePlaceholder')}
                                            onChange={(event) => {
                                              setPolicyError(null);
                                              setShowPolicyRefreshHint(false);
                                              setProfileDraftPatterns((currentPatterns) => {
                                                const currentProfilePatterns = currentPatterns[policyProfileId]?.[permissionKind] ?? profilePatterns;
                                                const nextPatterns = currentProfilePatterns.length > 0 ? [...currentProfilePatterns] : [''];
                                                nextPatterns[index] = event.target.value;
                                                return {
                                                  ...currentPatterns,
                                                  [policyProfileId]: {
                                                    ...(currentPatterns[policyProfileId] ?? { read: [], write: [], action: [] }),
                                                    [permissionKind]: nextPatterns,
                                                  },
                                                };
                                              });
                                            }}
                                            onBlur={(event) => {
                                              const currentProfilePatterns = profileDraftPatterns[policyProfileId]?.[permissionKind] ?? profilePatterns;
                                              const nextPatterns = currentProfilePatterns.length > 0 ? [...currentProfilePatterns] : [''];
                                              nextPatterns[index] = event.target.value;
                                              void commitProfileDraftPatterns(policyProfileId, permissionKind, nextPatterns);
                                            }}
                                            onKeyDown={(event) => {
                                              if (event.key === 'Enter') {
                                                event.preventDefault();
                                                (event.currentTarget as HTMLInputElement).blur();
                                              }
                                            }}
                                          />
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="icon"
                                            className="shrink-0"
                                            disabled={savingPolicy}
                                            aria-label={t('settings.browser.policy.removeRule')}
                                            onClick={() => {
                                              const nextPatterns = (profilePatterns.length > 0 ? profilePatterns : ['']).filter((_, currentIndex) => currentIndex !== index);
                                              setProfileDraftPatterns((currentPatterns) => ({
                                                ...currentPatterns,
                                                [policyProfileId]: {
                                                  ...(currentPatterns[policyProfileId] ?? { read: [], write: [], action: [] }),
                                                  [permissionKind]: nextPatterns,
                                                },
                                              }));
                                              void commitProfileDraftPatterns(policyProfileId, permissionKind, nextPatterns).catch(() => {});
                                            }}
                                          >
                                            <Trash2 className="size-4" />
                                          </Button>
                                        </div>
                                        {patternError ? (
                                          <p className="text-ui-xs text-destructive">{patternError}</p>
                                        ) : null}
                                      </div>
                                    );
                                  })}

                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    data-icon="inline-start"
                                    disabled={savingPolicy}
                                    onClick={() => {
                                      setShowPolicyRefreshHint(false);
                                      setProfileDraftPatterns((currentPatterns) => {
                                        const currentProfilePatterns = currentPatterns[policyProfileId]?.[permissionKind] ?? profilePatterns;
                                        return {
                                          ...currentPatterns,
                                          [policyProfileId]: {
                                            ...(currentPatterns[policyProfileId] ?? { read: [], write: [], action: [] }),
                                            [permissionKind]: [...currentProfilePatterns, ''],
                                          },
                                        };
                                      });
                                    }}
                                  >
                                    <Plus className="size-4" />
                                    {t('settings.browser.policy.addProfileRule')}
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </SettingsCard>
                );
              })}
            </div>
          </div>
        ) : null}

        {showPolicyRefreshHint && !policyError ? (
          <p className="pt-2 text-ui-xs leading-5 text-muted-foreground text-pretty">
            {t('settings.browser.policy.refreshHint')}
          </p>
        ) : null}

        {policyError ? (
          <p className="pt-2 text-ui-sm text-destructive">{policyError}</p>
        ) : null}

        {BROWSER_ACCESS_PERMISSION_KINDS.some((permissionKind) => policy.permissions[permissionKind].mode === 'allowList') ? (
          <div className="space-y-4 py-[18px]">
            {BROWSER_ACCESS_PERMISSION_KINDS.filter((permissionKind) => (
              policy.permissions[permissionKind].mode === 'allowList'
            )).map((permissionKind) => {
              const permissionPatterns = draftPatterns[permissionKind];
              return (
                <div key={`global-${permissionKind}`} className="space-y-3">
                  <SettingsCard tone={policy.permissions[permissionKind].allowedPatterns.length === 0 ? 'danger' : 'muted'} style={insetCardStyle}>
                    <p className="text-ui-sm font-medium text-foreground">
                      {t(BROWSER_ACCESS_PERMISSION_LABEL_KEYS[permissionKind])}
                    </p>
                    <p className="mt-1 text-ui-sm leading-6 text-muted-foreground text-pretty">
                      {policy.permissions[permissionKind].allowedPatterns.length === 0
                        ? t('settings.browser.policy.noRulesDescription')
                        : t('settings.browser.policy.examplesTitle')}
                    </p>
                    {policy.permissions[permissionKind].allowedPatterns.length > 0 ? (
                      <div className="mt-2 space-y-1 text-ui-sm text-muted-foreground">
                        <p>{t('settings.browser.policy.exampleSite')}</p>
                        <p>{t('settings.browser.policy.exampleSubdomain')}</p>
                        <p>{t('settings.browser.policy.exampleLocal')}</p>
                      </div>
                    ) : null}
                  </SettingsCard>

                  <div className="space-y-3">
                    {(permissionPatterns.length > 0 ? permissionPatterns : ['']).map((pattern, index) => {
                      const patternError = getPatternError(pattern);
                      return (
                        <div key={`${permissionKind}-page-rule-${index}`} className="space-y-2">
                          <div className="flex items-start gap-2">
                            <Input
                              value={pattern}
                              disabled={savingPolicy}
                              placeholder={t('settings.browser.policy.rulePlaceholder')}
                              onChange={(event) => {
                                setPolicyError(null);
                                setShowPolicyRefreshHint(false);
                                setDraftPatterns((currentPatterns) => {
                                  const currentPermissionPatterns = currentPatterns[permissionKind];
                                  const nextPatterns = currentPermissionPatterns.length > 0 ? [...currentPermissionPatterns] : [''];
                                  nextPatterns[index] = event.target.value;
                                  return {
                                    ...currentPatterns,
                                    [permissionKind]: nextPatterns,
                                  };
                                });
                              }}
                              onBlur={(event) => {
                                const nextPatterns = permissionPatterns.length > 0 ? [...permissionPatterns] : [''];
                                nextPatterns[index] = event.target.value;
                                void commitDraftPatterns(permissionKind, nextPatterns);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  (event.currentTarget as HTMLInputElement).blur();
                                }
                              }}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="shrink-0"
                              disabled={savingPolicy}
                              aria-label={t('settings.browser.policy.removeRule')}
                              onClick={() => {
                                const nextPatterns = (permissionPatterns.length > 0 ? permissionPatterns : ['']).filter((_, currentIndex) => currentIndex !== index);
                                setDraftPatterns((currentPatterns) => ({
                                  ...currentPatterns,
                                  [permissionKind]: nextPatterns,
                                }));
                                void commitDraftPatterns(permissionKind, nextPatterns).catch(() => {});
                              }}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                          {patternError ? (
                            <p className="text-ui-xs text-destructive">{patternError}</p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-icon="inline-start"
                      disabled={savingPolicy}
                      onClick={() => {
                        setShowPolicyRefreshHint(false);
                        setDraftPatterns((currentPatterns) => ({
                          ...currentPatterns,
                          [permissionKind]: [...currentPatterns[permissionKind], ''],
                        }));
                      }}
                    >
                      <Plus className="size-4" />
                      {t('settings.browser.policy.addRule')}
                    </Button>

                    {savingPolicy ? (
                      <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        {t('settings.browser.policy.saving')}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t('settings.browser.connectionsTitle')}
        description={t(connectionDescriptionKey)}
      >
        {loading && !status ? (
          <div className="flex items-center gap-2 py-[18px] text-ui-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('settings.browser.loadingConnections')}
          </div>
        ) : connections.length === 0 ? (
          <div className="py-[18px]">
            <p className="text-ui-sm font-medium text-foreground">
              {t('settings.browser.emptyTitle')}
            </p>
            <p className="mt-1 text-ui-sm leading-6 text-muted-foreground text-pretty">
              {policy.permissions.read.mode === 'allowList'
                ? t('settings.browser.emptyRestrictedDescription')
                : policy.permissions.read.mode === 'ask'
                  ? t('settings.browser.emptyAskDescription')
                  : policy.permissions.read.mode === 'deny'
                    ? t('settings.browser.emptyDenyDescription')
                : t('settings.browser.emptyDescription')}
            </p>
          </div>
        ) : (
          connections.map((connection) => {
            const displayedTargets = connection.targets.slice(0, TARGET_PREVIEW_LIMIT);
            const extraTargetCount = Math.max(0, connection.targets.length - displayedTargets.length);
            const browserName = formatBrowserName(
              connection.browserName,
              t('settings.browser.connection.fallbackName'),
            );

            return (
              <div key={connection.extensionId} className="py-[18px]">
                <SettingsCard
                  className="overflow-hidden rounded-[14px] px-0 py-0"
                  style={insetCardStyle}
                >
                  <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-ui-sm font-medium leading-6 text-foreground">
                          {browserName}
                        </h4>
                        <Badge variant={connection.activeSessions > 0 ? 'secondary' : 'outline'}>
                          {getSessionCountLabel(connection.activeSessions, t)}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {displayedTargets.length > 0 ? (
                    <div className="[border-top:var(--border-width)_solid_var(--border)] [&>*+*]:[border-top:var(--border-width)_solid_var(--border)]">
                      {displayedTargets.map((target) => (
                        <div key={target.targetId} className="flex items-start justify-between gap-3 px-4 py-3">
                          <div className="min-w-0 space-y-1">
                            <p className="truncate text-ui-sm font-medium text-foreground">
                              {formatTargetTitle(target, t('settings.browser.connection.untitledTarget'))}
                            </p>
                            <p className="truncate text-ui-xs text-muted-foreground">
                              {formatTargetSubtitle(target, t('settings.browser.connection.openPage'))}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="px-4 pb-4 text-ui-sm text-muted-foreground">
                      {t('settings.browser.connection.noSessions')}
                    </p>
                  )}

                  {extraTargetCount > 0 ? (
                    <p className="px-4 pb-4 text-ui-xs text-muted-foreground">
                      {t('settings.browser.connection.moreSessions', { count: extraTargetCount })}
                    </p>
                  ) : null}
                </SettingsCard>
              </div>
            );
          })
        )}
      </SettingsSection>
    </SettingsPane>
  );
}
