import { useState, useEffect, useCallback, useMemo } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import {
  CUA_ACCESS_PERMISSION_KINDS,
  DEFAULT_CUA_ACCESS_POLICY,
  getCuaAccessAppPolicy,
  normalizeCuaAppId,
  type CuaAccessAppPolicy,
  type CuaAccessPermissionKind,
  type CuaAccessPolicy,
  type CuaAccessPolicyMode,
  type CuaAccessRule,
} from '../../../shared/cuaAccessPolicy';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '../ui/select';
import { SettingsRow } from './SettingsSection';
import { useAgentActivityMap } from '@/hooks/useAgentActivityMap';
import { getRuntimeSystemInfo, nativeTools } from '@/ipc';
import {
  CODEX_SANDBOX_MODE_CHANGED_EVENT,
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexReadAccessMode,
  type CodexSandboxMode,
} from '@/lib/codex/sandbox-ui';
import { trackSettingChanged } from '@/utils/telemetry';

type ApprovalPolicy = 'never' | 'on-failure' | 'on-request' | 'untrusted';
type FileReadAccess = 'folder' | 'anywhere';
type FileWriteAccess = 'ask-first' | 'folder' | 'anywhere';
type TempAccess = 'off' | 'on';

type RuntimePermissionChange =
  | { kind: 'view-files'; value: FileReadAccess }
  | { kind: 'change-files'; value: FileWriteAccess }
  | { kind: 'temporary-files'; value: TempAccess }
  | { kind: 'network'; value: boolean };

type RuntimeSelectOption = {
  value: string;
  label: string;
  description: string;
};

const FILE_READ_OPTIONS: RuntimeSelectOption[] = [
  {
    value: 'folder',
    label: 'Current folder',
    description: 'Only view files in the folder you opened here.',
  },
  {
    value: 'anywhere',
    label: 'Anywhere',
    description: 'View files outside your current folder too.',
  },
];

const FILE_WRITE_OPTIONS: RuntimeSelectOption[] = [
  {
    value: 'ask-first',
    label: 'Ask first',
    description: 'Ask before changing files.',
  },
  {
    value: 'folder',
    label: 'Current folder',
    description: 'Change files in the current folder without asking first.',
  },
  {
    value: 'anywhere',
    label: 'Anywhere',
    description: 'Change files anywhere without asking first.',
  },
];

const TEMP_ACCESS_OPTIONS: RuntimeSelectOption[] = [
  {
    value: 'off',
    label: 'Off',
    description: 'Interpreter cannot use /tmp screenshots, so pasted overlay images and Interpreter Overlay are unavailable.',
  },
  {
    value: 'on',
    label: 'On',
    description: 'Allow /tmp working files for screenshots, pasted overlay images, and Interpreter Overlay.',
  },
];

const CUA_ACCESS_MODE_OPTIONS: RuntimeSelectOption[] = [
  {
    value: 'ask',
    label: 'Ask first',
    description: 'Ask before using this native app capability.',
  },
  {
    value: 'deny',
    label: 'Never',
    description: 'Do not let Interpreter use this native app capability.',
  },
  {
    value: 'all',
    label: 'Allow',
    description: 'Allow this native app capability without asking again.',
  },
];

const CUA_PERMISSION_LABELS: Record<CuaAccessPermissionKind, string> = {
  inspect: 'Inspect',
  control: 'Control',
};

function findOption(
  options: RuntimeSelectOption[],
  value: string,
): RuntimeSelectOption {
  return options.find((option) => option.value === value) ?? options[0];
}

function deriveFileReadAccess(
  sandboxMode: CodexSandboxMode,
  readAccessMode: CodexReadAccessMode,
): FileReadAccess {
  if (sandboxMode === 'danger-full-access' || readAccessMode === 'full-system') {
    return 'anywhere';
  }
  return 'folder';
}

function deriveFileWriteAccess(
  sandboxMode: CodexSandboxMode,
  approvalPolicy: ApprovalPolicy,
): FileWriteAccess {
  if (sandboxMode === 'danger-full-access') {
    return 'anywhere';
  }
  if (approvalPolicy === 'on-request' || approvalPolicy === 'untrusted' || sandboxMode === 'read-only') {
    return 'ask-first';
  }
  return 'folder';
}

function deriveTempAccess(
  tempAccessEnabled: boolean,
  _screenshotAccessEnabled: boolean,
): TempAccess {
  return tempAccessEnabled ? 'on' : 'off';
}

function getRuntimeChangeLabel(change: RuntimePermissionChange): string {
  switch (change.kind) {
    case 'view-files':
      return 'file viewing';
    case 'change-files':
      return 'file changes';
    case 'temporary-files':
      return 'temporary files';
    case 'network':
      return 'network access';
  }
}

function replaceCuaPolicyRule(
  policy: CuaAccessPolicy,
  permissionKind: CuaAccessPermissionKind,
  nextRule: CuaAccessRule,
): CuaAccessPolicy {
  return {
    ...policy,
    permissions: {
      ...policy.permissions,
      [permissionKind]: nextRule,
    },
  };
}

function replaceCuaAppPolicy(
  policy: CuaAccessPolicy,
  nextAppPolicy: CuaAccessAppPolicy | null,
): CuaAccessPolicy {
  if (!nextAppPolicy) {
    return policy;
  }

  const appPolicies = policy.appPolicies.filter((appPolicy) => appPolicy.appId !== nextAppPolicy.appId);
  appPolicies.push(nextAppPolicy);
  return {
    ...policy,
    appPolicies,
  };
}

function removeCuaAppPolicy(
  policy: CuaAccessPolicy,
  appId: string,
): CuaAccessPolicy {
  return {
    ...policy,
    appPolicies: policy.appPolicies.filter((appPolicy) => appPolicy.appId !== appId),
  };
}

function replaceCuaAppPolicyRule(
  appPolicy: CuaAccessAppPolicy,
  permissionKind: CuaAccessPermissionKind,
  nextRule: CuaAccessRule,
): CuaAccessAppPolicy {
  return {
    ...appPolicy,
    permissions: {
      ...appPolicy.permissions,
      [permissionKind]: nextRule,
    },
  };
}

function buildDefaultCuaAppPolicy(appId: string, basePolicy: CuaAccessPolicy): CuaAccessAppPolicy {
  return {
    appId,
    displayName: appId,
    permissions: basePolicy.permissions,
  };
}

function requiresDangerousAccessConfirmation(change: RuntimePermissionChange): boolean {
  return change.kind === 'change-files' && change.value === 'anywhere';
}

function RuntimeSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: RuntimeSelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const selected = findOption(options, value);

  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger
        className="w-full justify-between sm:w-[15.5rem]"
        aria-label={selected.label}
      >
        <span className="truncate">{selected.label}</span>
      </SelectTrigger>
      <SelectContent align="end" position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex flex-col items-start gap-0.5">
              <span>{option.label}</span>
              <span className="text-ui-xs leading-5 text-muted-foreground">
                {option.description}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function NativeToolsSection() {
  "use no memo";

  const isMac = getRuntimeSystemInfo().platform === 'darwin';
  const agentActivityMap = useAgentActivityMap();
  const [codexNetworkAccess, setCodexNetworkAccess] = useState(true);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>('on-request');
  const [sandboxMode, setSandboxMode] = useState<CodexSandboxMode>('workspace-write');
  const [readAccessMode, setReadAccessMode] = useState<CodexReadAccessMode>('workspace-only');
  const [macosTempAccess, setMacosTempAccess] = useState(true);
  const [macosScreenshotAccess, setMacosScreenshotAccess] = useState(true);
  const [cuaAccessPolicy, setCuaAccessPolicy] = useState<CuaAccessPolicy>(DEFAULT_CUA_ACCESS_POLICY);
  const [newCuaAppName, setNewCuaAppName] = useState('');
  const [loading, setLoading] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [isSavingCuaPolicy, setIsSavingCuaPolicy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cuaPolicyError, setCuaPolicyError] = useState<string | null>(null);
  const [dangerousChange, setDangerousChange] = useState<RuntimePermissionChange | null>(null);
  const [pendingChange, setPendingChange] = useState<RuntimePermissionChange | null>(null);

  const runningConversationCount = useMemo(
    () => Array.from(agentActivityMap.values()).filter((activity) => activity.isRunning).length,
    [agentActivityMap],
  );

  useEffect(() => {
    async function load() {
      try {
        const [
          codexNetResult,
          approvalResult,
          sandboxResult,
          readAccessResult,
          macosTempResult,
          macosScreenshotResult,
          cuaPolicyResult,
        ] = await Promise.all([
          nativeTools.getNetworkAccess(),
          nativeTools.getApprovalPolicy(),
          nativeTools.getSandboxMode(),
          nativeTools.getReadAccessMode(),
          isMac ? nativeTools.getMacosTempAccess() : Promise.resolve({ enabled: true }),
          isMac ? nativeTools.getMacosScreenshotAccess() : Promise.resolve({ enabled: true }),
          nativeTools.getCuaAccessPolicy(),
        ]);

        setCodexNetworkAccess(codexNetResult.enabled ?? true);
        setApprovalPolicy((approvalResult.policy ?? 'on-request') as ApprovalPolicy);
        setSandboxMode((sandboxResult.mode ?? DEFAULT_CODEX_SANDBOX_MODE) as CodexSandboxMode);
        setReadAccessMode((readAccessResult.mode ?? 'workspace-only') as CodexReadAccessMode);
        setMacosTempAccess(macosTempResult.enabled ?? true);
        setMacosScreenshotAccess(macosScreenshotResult.enabled ?? true);
        setCuaAccessPolicy(cuaPolicyResult.policy);
      } catch (error) {
        console.error('Failed to load runtime permissions:', error);
        setErrorMessage('Could not load these permissions.');
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [isMac]);

  const applyLocalRuntimeChange = useCallback((change: RuntimePermissionChange) => {
    switch (change.kind) {
      case 'view-files':
        setReadAccessMode(change.value === 'anywhere' ? 'full-system' : 'workspace-only');
        break;
      case 'change-files':
        if (change.value === 'ask-first') {
          setApprovalPolicy('untrusted');
          setSandboxMode('workspace-write');
        } else if (change.value === 'folder') {
          setApprovalPolicy('never');
          setSandboxMode('workspace-write');
        } else {
          setApprovalPolicy('never');
          setSandboxMode('danger-full-access');
          setReadAccessMode('full-system');
        }
        window.dispatchEvent(new CustomEvent(CODEX_SANDBOX_MODE_CHANGED_EVENT, {
          detail: {
            mode:
              change.value === 'ask-first'
                ? 'workspace-write'
                : change.value === 'folder'
                  ? 'workspace-write'
                  : 'danger-full-access',
          },
        }));
        break;
      case 'temporary-files': {
        const enabled = change.value === 'on';
        setMacosTempAccess(enabled);
        setMacosScreenshotAccess(enabled);
        break;
      }
      case 'network':
        setCodexNetworkAccess(change.value);
        break;
    }
  }, []);

  const persistRuntimeChange = useCallback(async (change: RuntimePermissionChange) => {
    trackSettingChanged({
      settingKey: `runtimePermissions.${change.kind}`,
      tabId: 'permissions',
      sectionId: 'runtimePermissions',
      valueType: 'enum',
      newValue: change.value,
    });
    switch (change.kind) {
      case 'view-files':
        await nativeTools.setReadAccessMode(change.value === 'anywhere' ? 'full-system' : 'workspace-only');
        break;
      case 'change-files':
        if (change.value === 'ask-first') {
          await nativeTools.setApprovalPolicy('untrusted');
          await nativeTools.setSandboxMode('workspace-write');
        } else if (change.value === 'folder') {
          await nativeTools.setApprovalPolicy('never');
          await nativeTools.setSandboxMode('workspace-write');
        } else {
          await nativeTools.setApprovalPolicy('never');
          await nativeTools.setReadAccessMode('full-system');
          await nativeTools.setSandboxMode('danger-full-access');
        }
        break;
      case 'temporary-files': {
        const enabled = change.value === 'on';
        await nativeTools.setMacosTempAccess(enabled);
        await nativeTools.setMacosScreenshotAccess(enabled);
        break;
      }
      case 'network':
        await nativeTools.setNetworkAccess(change.value);
        break;
    }
  }, []);

  const applyRuntimeChange = useCallback(async (change: RuntimePermissionChange) => {
    const changeLabel = getRuntimeChangeLabel(change);
    setIsApplying(true);
    setErrorMessage(null);
    setStatusMessage(`Restarting Interpreter to update ${changeLabel}...`);

    let didPersist = false;
    try {
      await persistRuntimeChange(change);
      didPersist = true;
      applyLocalRuntimeChange(change);
      await nativeTools.restart();
      setStatusMessage(null);
    } catch (error) {
      console.error(`Failed to update ${changeLabel}:`, error);
      setStatusMessage(null);
      setErrorMessage(
        didPersist
          ? `Saved ${changeLabel}, but Interpreter could not restart cleanly.`
          : `Could not update ${changeLabel}.`,
      );
    } finally {
      setIsApplying(false);
    }
  }, [applyLocalRuntimeChange, persistRuntimeChange]);

  const saveCuaPolicy = useCallback(async (nextPolicy: CuaAccessPolicy) => {
    setIsSavingCuaPolicy(true);
    setCuaPolicyError(null);

    try {
      const result = await nativeTools.setCuaAccessPolicy(nextPolicy);
      setCuaAccessPolicy(result.policy);
      return result.policy;
    } catch (error) {
      console.error('Failed to update Computer Use app permissions:', error);
      setCuaPolicyError('Could not update Computer Use app permissions.');
      throw error;
    } finally {
      setIsSavingCuaPolicy(false);
    }
  }, []);

  const addCuaAppRule = useCallback(() => {
    let appId: string;
    try {
      appId = normalizeCuaAppId(newCuaAppName);
    } catch (error) {
      setCuaPolicyError(error instanceof Error ? error.message : 'Computer Use app rules require an app name.');
      return;
    }

    if (getCuaAccessAppPolicy(cuaAccessPolicy, appId)) {
      setCuaPolicyError(`A Computer Use rule for "${appId}" already exists.`);
      return;
    }

    void saveCuaPolicy(replaceCuaAppPolicy(
      cuaAccessPolicy,
      buildDefaultCuaAppPolicy(appId, cuaAccessPolicy),
    )).then(() => {
      setNewCuaAppName('');
    }).catch(() => {});
  }, [cuaAccessPolicy, newCuaAppName, saveCuaPolicy]);

  const queueOrApplyRuntimeChange = useCallback((change: RuntimePermissionChange) => {
    if (isApplying) return;
    setErrorMessage(null);

    if (runningConversationCount > 0) {
      setPendingChange(change);
      return;
    }

    void applyRuntimeChange(change);
  }, [applyRuntimeChange, isApplying, runningConversationCount]);

  const requestRuntimeChange = useCallback((change: RuntimePermissionChange) => {
    if (isApplying) return;
    setErrorMessage(null);

    if (requiresDangerousAccessConfirmation(change)) {
      setDangerousChange(change);
      return;
    }

    queueOrApplyRuntimeChange(change);
  }, [isApplying, queueOrApplyRuntimeChange]);

  const confirmDangerousChange = useCallback(() => {
    if (!dangerousChange) {
      return;
    }

    const change = dangerousChange;
    setDangerousChange(null);
    queueOrApplyRuntimeChange(change);
  }, [dangerousChange, queueOrApplyRuntimeChange]);

  const confirmPendingChange = useCallback(() => {
    if (!pendingChange) return;
    const change = pendingChange;
    setPendingChange(null);
    void applyRuntimeChange(change);
  }, [applyRuntimeChange, pendingChange]);

  const fileWriteAccess = useMemo(
    () => deriveFileWriteAccess(sandboxMode, approvalPolicy),
    [approvalPolicy, sandboxMode],
  );
  const fileReadAccess = useMemo(
    () => (
      fileWriteAccess === 'anywhere'
        ? 'anywhere'
        : deriveFileReadAccess(sandboxMode, readAccessMode)
    ),
    [fileWriteAccess, readAccessMode, sandboxMode],
  );
  const tempAccess = useMemo(
    () => deriveTempAccess(macosTempAccess, macosScreenshotAccess),
    [macosScreenshotAccess, macosTempAccess],
  );

  if (loading) {
    return <div className="py-[18px] text-ui-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <>
      <SettingsRow
        label="View files"
        description={
          fileWriteAccess === 'anywhere'
            ? 'Included when Interpreter can change files anywhere.'
            : 'Choose which files Interpreter can open to inspect.'
        }
        contentClassName="sm:justify-end"
      >
        <RuntimeSelect
          value={fileReadAccess}
          options={FILE_READ_OPTIONS}
          disabled={isApplying || fileWriteAccess === 'anywhere'}
          onChange={(value) => {
            const nextValue = value as FileReadAccess;
            if (nextValue === fileReadAccess || fileWriteAccess === 'anywhere') {
              return;
            }
            requestRuntimeChange({ kind: 'view-files', value: nextValue });
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Change files"
        description="Choose when Interpreter can edit files on its own."
        contentClassName="sm:justify-end"
      >
        <RuntimeSelect
          value={fileWriteAccess}
          options={FILE_WRITE_OPTIONS}
          disabled={isApplying}
          onChange={(value) => {
            const nextValue = value as FileWriteAccess;
            if (nextValue === fileWriteAccess) {
              return;
            }
            requestRuntimeChange({ kind: 'change-files', value: nextValue });
          }}
        />
      </SettingsRow>

      {isMac ? (
        <SettingsRow
          label="Temporary files"
          description={
            tempAccess === 'off'
              ? 'Interpreter cannot see saved screenshots in /tmp, so pasted overlay images and Interpreter Overlay are unavailable.'
              : 'Allow Interpreter to use temporary working files on your Mac, including saved screenshots for pasted overlay images and Interpreter Overlay.'
          }
          contentClassName="sm:justify-end"
        >
          <RuntimeSelect
            value={tempAccess}
            options={TEMP_ACCESS_OPTIONS}
            disabled={isApplying}
            onChange={(value) => {
              const nextValue = value as TempAccess;
              if (nextValue === tempAccess) {
                return;
              }
              requestRuntimeChange({ kind: 'temporary-files', value: nextValue });
            }}
          />
        </SettingsRow>
      ) : null}

      <SettingsRow
        label="Inspect apps"
        description="Choose when Interpreter can read visible text, controls, and window structure from native apps."
        contentClassName="sm:justify-end"
      >
        <RuntimeSelect
          value={cuaAccessPolicy.permissions.inspect.mode}
          options={CUA_ACCESS_MODE_OPTIONS}
          disabled={isSavingCuaPolicy}
          onChange={(value) => {
            const nextValue = value as CuaAccessPolicyMode;
            if (nextValue === cuaAccessPolicy.permissions.inspect.mode) {
              return;
            }
            void saveCuaPolicy(replaceCuaPolicyRule(cuaAccessPolicy, 'inspect', { mode: nextValue })).catch(() => {});
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Control apps"
        description="Choose when Interpreter can click, type, move windows, or change native apps."
        contentClassName="sm:justify-end"
      >
        <RuntimeSelect
          value={cuaAccessPolicy.permissions.control.mode}
          options={CUA_ACCESS_MODE_OPTIONS}
          disabled={isSavingCuaPolicy}
          onChange={(value) => {
            const nextValue = value as CuaAccessPolicyMode;
            if (nextValue === cuaAccessPolicy.permissions.control.mode) {
              return;
            }
            void saveCuaPolicy(replaceCuaPolicyRule(cuaAccessPolicy, 'control', { mode: nextValue })).catch(() => {});
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="App rules"
        description="Override the native app defaults for specific apps such as TextEdit, Finder, or Slack."
        layout="wide"
        align="start"
        contentClassName="lg:justify-end"
      >
        <div className="flex w-full max-w-[36rem] flex-col gap-3">
          {cuaAccessPolicy.appPolicies.length > 0 ? (
            <div
              className="overflow-hidden rounded-[var(--oa-radius-md)] bg-[var(--oa-bg-subtle)]"
              style={{ border: 'var(--border-width) solid var(--border)' }}
            >
              {cuaAccessPolicy.appPolicies.map((appPolicy) => (
                <div
                  key={appPolicy.appId}
                  className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between [&+&]:[border-top:var(--border-width)_solid_var(--border)]"
                >
                  <div className="min-w-0 text-ui-sm font-medium text-foreground">
                    {appPolicy.displayName}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {CUA_ACCESS_PERMISSION_KINDS.map((permissionKind) => (
                      <label
                        key={`${appPolicy.appId}-${permissionKind}`}
                        className="flex items-center gap-2 text-ui-sm text-muted-foreground"
                      >
                        <span>{CUA_PERMISSION_LABELS[permissionKind]}</span>
                        <RuntimeSelect
                          value={appPolicy.permissions[permissionKind].mode}
                          options={CUA_ACCESS_MODE_OPTIONS}
                          disabled={isSavingCuaPolicy}
                          onChange={(value) => {
                            const nextValue = value as CuaAccessPolicyMode;
                            if (nextValue === appPolicy.permissions[permissionKind].mode) {
                              return;
                            }
                            void saveCuaPolicy(replaceCuaAppPolicy(
                              cuaAccessPolicy,
                              replaceCuaAppPolicyRule(appPolicy, permissionKind, { mode: nextValue }),
                            )).catch(() => {});
                          }}
                        />
                      </label>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${appPolicy.displayName} rule`}
                      disabled={isSavingCuaPolicy}
                      onClick={() => {
                        void saveCuaPolicy(removeCuaAppPolicy(cuaAccessPolicy, appPolicy.appId)).catch(() => {});
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-ui-sm leading-6 text-muted-foreground">
              No app-specific Computer Use rules.
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newCuaAppName}
              disabled={isSavingCuaPolicy}
              placeholder="App name"
              aria-label="Native app name"
              onChange={(event) => {
                setNewCuaAppName(event.target.value);
                setCuaPolicyError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCuaAppRule();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={isSavingCuaPolicy}
              onClick={addCuaAppRule}
            >
              <Plus className="size-4" />
              <span>Add app</span>
            </Button>
          </div>
          {cuaPolicyError ? (
            <div className="text-ui-sm text-destructive">{cuaPolicyError}</div>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        label="Network"
        description="Allow Interpreter to connect to websites and services."
      >
        <Switch
          checked={codexNetworkAccess}
          disabled={isApplying}
          onCheckedChange={(checked) => {
            const nextValue = checked === true;
            if (nextValue === codexNetworkAccess) {
              return;
            }
            requestRuntimeChange({ kind: 'network', value: nextValue });
          }}
        />
      </SettingsRow>

      {statusMessage ? (
        <div className="py-[18px] text-ui-sm text-muted-foreground">
          {statusMessage}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="py-[18px] text-ui-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <div className="py-[18px] text-ui-sm leading-6 text-muted-foreground">
        These permissions are shared across every conversation. Changing them restarts Interpreter.
      </div>

      <AlertDialog
        open={dangerousChange !== null}
        onOpenChange={(open) => {
          if (!open && !isApplying) {
            setDangerousChange(null);
          }
        }}
      >
        <AlertDialogContent
          size="default"
          className="gap-0 overflow-hidden p-0"
        >
          <AlertDialogHeader
            className="gap-4 px-6 pb-5 pt-6 sm:px-7 sm:pb-6 sm:pt-7"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--oa-danger-soft) 70%, transparent) 0%, transparent 72%)",
            }}
          >
            <AlertDialogMedia className="bg-[var(--oa-danger-soft)] text-[var(--oa-danger)]">
              <AlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle>Enable Full Access?</AlertDialogTitle>
            <AlertDialogDescription>
              Full Access is very dangerous. Interpreter will be able to read and write outside your current folder.
              {' '}We recommend using this only with smart models like GPT-5.4.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="px-6 pb-5 sm:px-7 sm:pb-6">
            <AlertDialogCancel
              disabled={isApplying}
              className="sm:min-w-[9rem]"
            >
              Keep workspace write
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isApplying}
              onClick={confirmDangerousChange}
              className="sm:min-w-[10rem]"
            >
              Enable Full Access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!open && !isApplying) {
            setPendingChange(null);
          }
        }}
      >
        <AlertDialogContent
          size="default"
          className="gap-0 overflow-hidden p-0"
        >
          <AlertDialogHeader
            className="gap-4 px-6 pb-5 pt-6 sm:px-7 sm:pb-6 sm:pt-7"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--oa-bg-subtle) 22%, transparent) 0%, transparent 72%)",
            }}
          >
            <AlertDialogMedia className="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
              <AlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle>Restart Interpreter?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingChange
                ? `${runningConversationCount} conversation${runningConversationCount === 1 ? ' is' : 's are'} still running. To update ${getRuntimeChangeLabel(pendingChange)}, Interpreter needs to restart. This will stop ${runningConversationCount === 1 ? 'that conversation' : 'those conversations'} for every agent.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="px-6 pb-5 sm:px-7 sm:pb-6">
            <AlertDialogCancel
              disabled={isApplying}
              className="sm:min-w-[9rem]"
            >
              Keep current settings
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isApplying}
              onClick={confirmPendingChange}
              className="sm:min-w-[10rem]"
            >
              Restart and apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
