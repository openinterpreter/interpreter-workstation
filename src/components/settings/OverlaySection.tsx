import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { getProfiles, getRecentWorkspaces, type RecentWorkspaceFolder } from "@/api";
import { getRuntimeSystemInfo, openExternal, overlaySettings } from "@/ipc";
import { useAuth } from "@/contexts/AuthContext";
import { useLayoutActions } from "@/hooks/useLayout";
import { cn } from "@/lib/utils";
import { shouldResetOverlaySetupState } from "@/lib/overlaySetup";
import { trackOverlaySettingChanged, trackSettingChanged } from "@/utils/telemetry";
import { isMacPlatform } from "@/utils/platformShortcuts";
import {
  DEFAULT_INTERPRETER_OVERLAY_SETTINGS,
  type InterpreterOverlaySettings,
} from "../../../apps/interpreter-overlay/shared/settings";
import type { InterpreterOverlayAccessState } from "../../../server/lib/subscriptionStatus";
import { WORKSTATION_PRO_PRICE_ID } from "../../../shared/constants/interpreter-plans";
import { getInterpreterHostedApiBaseUrl } from "../../../shared/hostedApi";
import { CheckCircle2, ExternalLink, LockKeyhole } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { SettingsCard } from "./SettingsSection";
import type { Profile } from "../../../shared/types/profile";
import { useToast } from "@/contexts/ToastContext";

function getHostedBillingBaseUrl(): string {
  const baseUrl = getInterpreterHostedApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Hosted billing is not configured for this distribution.");
  }
  return baseUrl;
}

function getHotkeyKey(key: string): string | null {
  if (key.length === 1 && /[a-z0-9]/i.test(key)) {
    return key.toUpperCase();
  }

  switch (key) {
    case " ":
    case "Spacebar":
      return "Space";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Enter":
    case "Tab":
    case "Escape":
    case "Backspace":
    case "Delete":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
      return key;
    default:
      if (/^F\d{1,2}$/i.test(key)) {
        return key.toUpperCase();
      }
      return null;
  }
}

function formatHotkeyFromEvent(
  event: React.KeyboardEvent<HTMLInputElement>,
): string | null {
  const key = getHotkeyKey(event.key);
  if (!key) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push(isMacPlatform() ? "Command" : "Meta");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  if (modifiers.length === 0) {
    return null;
  }

  return [...modifiers, key].join("+");
}

type OverlayScreenRecordingStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

interface OverlayPermissionStatus {
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  screenRecordingStatus: OverlayScreenRecordingStatus;
}

interface StripeCustomerResponse {
  data?: {
    customer_id?: string;
  };
}

interface StripeCheckoutResponse {
  data?: {
    sessionUrl?: string;
  };
  sessionUrl?: string;
  error?: unknown;
}

type MissingOverlayPermission = "accessibility" | "screen-recording";
const ADVANCED_VOICE_DESKTOP_WORKSPACE_VALUE = "__advanced_voice_desktop__";
const OVERLAY_TEXT_DEFAULT_PROFILE_VALUE = "__overlay_text_default_profile__";

function getBillingErrorMessage(defaultMessage: string, error?: unknown): string {
  return typeof error === "string" && error.trim() ? error : defaultMessage;
}

function hasProfileModelValue(profiles: Profile[], value: string): boolean {
  return profiles.some((profile) => profile.id === value || profile.modelId === value);
}

function getNextMissingOverlayPermission(
  status: OverlayPermissionStatus,
  options?: { requiresAccessibility: boolean },
): MissingOverlayPermission | null {
  if (options?.requiresAccessibility !== false && !status.accessibilityGranted) {
    return "accessibility";
  }

  if (!status.screenRecordingGranted) {
    return "screen-recording";
  }

  return null;
}

function getScreenRecordingPermissionDetail(
  status: OverlayScreenRecordingStatus,
): string {
  switch (status) {
    case "granted":
      return "Granted";
    case "not-determined":
      return "Not requested yet";
    case "denied":
      return "Denied";
    case "restricted":
      return "Restricted";
    default:
      return "Unknown";
  }
}

export function OverlaySectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const { user, session, loading: authLoading } = useAuth();
  const { openSettings } = useLayoutActions();
  const { showToast } = useToast();
  const runtimePlatform = getRuntimeSystemInfo().platform;
  const requiresAccessibilityPermission = isMacPlatform(runtimePlatform);
  const usesOverlayPermissionSetupDialog =
    runtimePlatform === "darwin" || runtimePlatform === "linux";
  const isLinuxPlatform = runtimePlatform === "linux";
  const screenCaptureLabel = requiresAccessibilityPermission
    ? "Screen Recording"
    : "Screen Capture";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [settingsState, setSettingsState] =
    useState<InterpreterOverlaySettings>(DEFAULT_INTERPRETER_OVERLAY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
  const [showPermissionSetup, setShowPermissionSetup] = useState(false);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [activePermissionRequest, setActivePermissionRequest] = useState<
    MissingOverlayPermission | "enable" | null
  >(null);
  const [permissionStatus, setPermissionStatus] =
    useState<OverlayPermissionStatus | null>(null);
  const [permissionRequestError, setPermissionRequestError] = useState<
    string | null
  >(null);
  const [voiceProfiles, setVoiceProfiles] = useState<Profile[]>([]);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceFolder[]>([]);
  const [overlayAccessState, setOverlayAccessState] =
    useState<InterpreterOverlayAccessState | null>(null);
  const [overlayAccessLoading, setOverlayAccessLoading] = useState(true);
  const [isOpeningCheckout, setIsOpeningCheckout] = useState(false);
  const isOverlayEligible = overlayAccessState?.allowed === true;
  const settingsLocked = !overlayAccessLoading && !isOverlayEligible;
  const controlsDisabled =
    loading || overlayAccessLoading || isRequestingPermissions || settingsLocked;
  const controlCardStyle = {
    borderWidth: "var(--border-width)",
    borderColor:
      "color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)",
  } as const;
  const overlayTextProfileValue = settingsState.preferredProfileId
    ?? OVERLAY_TEXT_DEFAULT_PROFILE_VALUE;
  const advancedVoiceModelValue = settingsState.advancedVoiceModel;
  const hiddenAgentModelValue = settingsState.hiddenAgentModel;
  const advancedVoiceWorkspaceValue = settingsState.advancedVoiceWorkspacePath
    ? settingsState.advancedVoiceWorkspacePath
    : ADVANCED_VOICE_DESKTOP_WORKSPACE_VALUE;

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await overlaySettings.get();
        setSettingsState(response.settings);
      } catch (error) {
        console.error("Failed to load overlay settings:", error);
      } finally {
        setLoading(false);
      }
    }

    void loadSettings();
  }, []);

  useEffect(() => {
    if (authLoading) {
      return;
    }

    let cancelled = false;

    async function loadOverlayAccessState() {
      setOverlayAccessLoading(true);
      try {
        const response = await overlaySettings.getAccessState({ forceRefresh: true });
        if (!cancelled) {
          setOverlayAccessState(response.state);
        }
      } catch (error) {
        console.error("Failed to load overlay access state:", error);
        if (!cancelled) {
          setOverlayAccessState({
            allowed: false,
            reason: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (!cancelled) {
          setOverlayAccessLoading(false);
        }
      }
    }

    void loadOverlayAccessState();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user?.id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getProfiles().catch(() => ({ profiles: [] as Profile[] })),
      getRecentWorkspaces().catch(() => ({ folders: [] as RecentWorkspaceFolder[] })),
    ]).then(([profileResponse, workspaceResponse]) => {
      if (cancelled) {
        return;
      }
      setVoiceProfiles(profileResponse.profiles);
      setRecentWorkspaces(workspaceResponse.folders);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      !shouldResetOverlaySetupState({
        settingsLoading: loading,
        authLoading,
        paidPlanLoading: overlayAccessLoading,
        isOverlayEligible,
        settingsEnabled: settingsState.enabled,
        permissionSetupPending: settingsState.permissionSetupPending,
      })
    ) {
      return;
    }

    void persistSettings({
      ...settingsState,
      enabled: false,
      permissionSetupPending: false,
    });
  }, [authLoading, isOverlayEligible, loading, overlayAccessLoading, settingsState]);

  useEffect(() => {
    if (loading || showPermissionSetup) {
      return;
    }

    if (settingsState.enabled || !settingsState.permissionSetupPending) {
      return;
    }

    setPermissionStatus(null);
    setPermissionRequestError(null);
    setShowPermissionSetup(true);
  }, [
    loading,
    settingsState.enabled,
    settingsState.permissionSetupPending,
    showPermissionSetup,
  ]);

  async function persistSettings(nextSettings: InterpreterOverlaySettings) {
    const previousSettings = settingsState;
    setSettingsState(nextSettings);

    try {
      const response = await overlaySettings.set(nextSettings);
      setSettingsState(response.settings);
    } catch (error) {
      console.error("Failed to save overlay settings:", error);
      setSettingsState(previousSettings);
    }
  }

  function scopeSettingsToCurrentAccount(
    nextSettings: InterpreterOverlaySettings,
  ): InterpreterOverlaySettings {
    return {
      ...nextSettings,
      accountUserId: user?.id ?? null,
    };
  }

  async function saveSettings(nextSettings: InterpreterOverlaySettings) {
    if (controlsDisabled) {
      return;
    }

    const accountScopedSettings = scopeSettingsToCurrentAccount(nextSettings);

    if (settingsState.enabled !== accountScopedSettings.enabled) {
      trackOverlaySettingChanged({
        setting: "enabled",
        value: accountScopedSettings.enabled,
      });
      trackSettingChanged({
        settingKey: 'overlay.enabled', tabId: 'overlay', sectionId: 'overlay',
        valueType: 'boolean', oldValue: settingsState.enabled, newValue: accountScopedSettings.enabled,
      });
    }

    if (settingsState.hotkey !== accountScopedSettings.hotkey) {
      trackOverlaySettingChanged({ setting: "hotkey" });
      trackSettingChanged({
        settingKey: 'overlay.hotkey', tabId: 'overlay', sectionId: 'overlay',
        valueType: 'string', oldValue: settingsState.hotkey, newValue: accountScopedSettings.hotkey,
      });
    }

    if (settingsState.advancedVoiceEnabled !== accountScopedSettings.advancedVoiceEnabled) {
      trackSettingChanged({
        settingKey: 'overlay.advancedVoiceEnabled', tabId: 'overlay', sectionId: 'overlay',
        valueType: 'boolean', oldValue: settingsState.advancedVoiceEnabled, newValue: accountScopedSettings.advancedVoiceEnabled,
      });
    }

    if (settingsState.preferredProfileId !== accountScopedSettings.preferredProfileId) {
      trackSettingChanged({
        settingKey: 'overlay.preferredProfileId', tabId: 'overlay', sectionId: 'overlay',
        valueType: 'string', oldValue: settingsState.preferredProfileId ?? '', newValue: accountScopedSettings.preferredProfileId ?? '',
      });
    }

    if (settingsState.advancedVoiceModel !== accountScopedSettings.advancedVoiceModel) {
      trackSettingChanged({
        settingKey: 'overlay.advancedVoiceModel', tabId: 'overlay', sectionId: 'overlay',
        valueType: 'string', oldValue: settingsState.advancedVoiceModel, newValue: accountScopedSettings.advancedVoiceModel,
      });
    }

    if (settingsState.advancedVoiceWorkspacePath !== accountScopedSettings.advancedVoiceWorkspacePath) {
      trackSettingChanged({
        settingKey: 'overlay.advancedVoiceWorkspacePath', tabId: 'overlay', sectionId: 'overlay',
        valueType: 'string', oldValue: settingsState.advancedVoiceWorkspacePath ?? '', newValue: accountScopedSettings.advancedVoiceWorkspacePath ?? '',
      });
    }

    await persistSettings(accountScopedSettings);
  }

  async function handleEnableToggle(enabled: boolean) {
    if (!enabled) {
      await saveSettings({
        ...settingsState,
        enabled: false,
        permissionSetupPending: false,
      });
      return;
    }

    if (controlsDisabled || settingsState.enabled) {
      return;
    }

    if (!usesOverlayPermissionSetupDialog) {
      setIsRequestingPermissions(true);
      setActivePermissionRequest("screen-recording");
      setPermissionRequestError(null);

      try {
        const response = await overlaySettings.requestScreenRecordingPermission();
        setPermissionStatus(response.status);
        if (!response.success) {
          setPermissionRequestError(
            response.error ?? "Screen capture is still unavailable.",
          );
          await persistSettings(
            scopeSettingsToCurrentAccount({
              ...settingsState,
              permissionSetupPending: true,
            }),
          );
          setShowPermissionSetup(true);
          return;
        }

        await saveSettings({
          ...settingsState,
          enabled: true,
          permissionSetupPending: false,
        });
      } catch (error) {
        console.error("Failed to verify overlay screen capture access:", error);
        setPermissionRequestError(
          error instanceof Error ? error.message : String(error),
        );
        await persistSettings(
          scopeSettingsToCurrentAccount({
            ...settingsState,
            permissionSetupPending: true,
          }),
        );
        setShowPermissionSetup(true);
      } finally {
        setActivePermissionRequest(null);
        setIsRequestingPermissions(false);
      }
      return;
    }

    setPermissionStatus(null);
    setPermissionRequestError(null);
    await persistSettings(
      scopeSettingsToCurrentAccount({
        ...settingsState,
        permissionSetupPending: true,
      }),
    );
    setShowPermissionSetup(true);
  }

  async function resolveStripeCustomerId(): Promise<string | null> {
    if (!session?.access_token) {
      showToast(
        "Sign in before upgrading to unlock Interpreter Overlay.",
        "error",
        7000,
      );
      openSettings(undefined, "account");
      return null;
    }

    const customerResponse = await fetch(`${getHostedBillingBaseUrl()}/v0/stripe/new_customer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": session.access_token,
      },
      body: JSON.stringify({ customer_email: user?.email }),
    });

    let customerResult: StripeCustomerResponse | null = null;
    try {
      customerResult = await customerResponse.json() as StripeCustomerResponse;
    } catch (parseError) {
      console.error("[OverlaySection] Failed to parse checkout customer response", parseError);
    }

    if (!customerResponse.ok) {
      console.error("[OverlaySection] Failed to resolve Stripe customer for checkout", {
        status: customerResponse.status,
        result: customerResult,
      });
      showToast("Unable to open checkout right now. Please try again.", "error", 8000);
      return null;
    }

    const customerId = customerResult?.data?.customer_id;
    if (!customerId) {
      console.error("[OverlaySection] new_customer response missing customer_id", customerResult);
      showToast("Unable to open checkout right now. Please try again.", "error", 8000);
      return null;
    }

    return customerId;
  }

  async function handleOverlayUpgrade() {
    if (isOpeningCheckout) {
      return;
    }

    setIsOpeningCheckout(true);
    const genericCheckoutError = "Unable to open checkout right now. Please try again.";
    try {
      const customerId = await resolveStripeCustomerId();
      if (!customerId || !session?.access_token) {
        return;
      }

      const response = await fetch(`${getHostedBillingBaseUrl()}/v0/stripe/checkout_session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": session.access_token,
        },
        body: JSON.stringify({
          customerId,
          priceId: WORKSTATION_PRO_PRICE_ID,
        }),
      });

      let result: StripeCheckoutResponse | null = null;
      try {
        result = await response.json() as StripeCheckoutResponse;
      } catch (parseError) {
        console.error("[OverlaySection] Failed to parse checkout session response", parseError);
      }

      if (!response.ok) {
        console.error("[OverlaySection] Checkout session request failed", {
          status: response.status,
          result,
        });
        showToast(getBillingErrorMessage(genericCheckoutError, result?.error), "error", 9000);
        return;
      }

      const sessionUrl = result?.data?.sessionUrl || result?.sessionUrl;
      if (!sessionUrl) {
        console.error("[OverlaySection] Checkout session response missing sessionUrl", result);
        showToast(genericCheckoutError, "error", 8000);
        return;
      }

      await openExternal(sessionUrl);
    } catch (error) {
      console.error("[OverlaySection] Error creating checkout session:", error);
      showToast(genericCheckoutError, "error", 8000);
    } finally {
      setIsOpeningCheckout(false);
    }
  }

  async function cancelPermissionSetup() {
    setShowPermissionSetup(false);
    setPermissionStatus(null);
    setPermissionRequestError(null);

    await persistSettings(
      scopeSettingsToCurrentAccount({
        ...settingsState,
        permissionSetupPending: false,
      }),
    );
  }

  async function refreshPermissionStatus(options?: {
    surfaceErrors?: boolean;
  }): Promise<OverlayPermissionStatus | null> {
    try {
      const response = await overlaySettings.getPermissionStatus();
      setPermissionStatus(response.status);
      return response.status;
    } catch (error) {
      console.error("Failed to fetch overlay permission status:", error);
      if (options?.surfaceErrors) {
        setPermissionRequestError(
          error instanceof Error ? error.message : String(error),
        );
      }
      return null;
    }
  }

  useEffect(() => {
    if (!showPermissionSetup) {
      return;
    }

    let disposed = false;
    let inFlight = false;

    async function pollPermissionStatus(surfaceErrors: boolean) {
      if (disposed || inFlight) {
        return;
      }

      inFlight = true;
      try {
        await refreshPermissionStatus({ surfaceErrors });
      } finally {
        inFlight = false;
      }
    }

    void pollPermissionStatus(true);
    const interval = window.setInterval(() => {
      void pollPermissionStatus(false);
    }, 1500);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [showPermissionSetup]);

  async function runPermissionRequest(
    action: MissingOverlayPermission,
    requestPermission: () => Promise<{
      success: boolean;
      status: OverlayPermissionStatus;
      error?: string;
    }>,
  ) {
    if (controlsDisabled) {
      return;
    }

    setIsRequestingPermissions(true);
    setActivePermissionRequest(action);
    setPermissionRequestError(null);

    try {
      const response = await requestPermission();
      setPermissionStatus(response.status);
      if (!response.success) {
        setPermissionRequestError(
          response.error ?? "Permission is still not granted.",
        );
      }
    } catch (error) {
      console.error("Failed to request overlay permission:", error);
      setPermissionRequestError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setActivePermissionRequest(null);
      setIsRequestingPermissions(false);
    }
  }

  async function finishOverlayEnable() {
    if (controlsDisabled) {
      return;
    }

    setIsRequestingPermissions(true);
    setActivePermissionRequest("enable");
    setPermissionRequestError(null);

    try {
      const latestStatus = await refreshPermissionStatus({
        surfaceErrors: true,
      });
      if (!latestStatus) {
        return;
      }

      if (
        !latestStatus.accessibilityGranted ||
        !latestStatus.screenRecordingGranted
      ) {
        const missingPermission = getNextMissingOverlayPermission(latestStatus, {
          requiresAccessibility: requiresAccessibilityPermission,
        });
        setPermissionRequestError(
          missingPermission === "screen-recording"
            ? requiresAccessibilityPermission
              ? "Screen Recording permission is still required before enabling Overlay."
              : "Screen capture approval is still required before enabling Overlay."
            : "Accessibility permission is still required before enabling Overlay.",
        );
        return;
      }

      await saveSettings({
        ...settingsState,
        enabled: true,
        permissionSetupPending: false,
      });
      setShowPermissionSetup(false);
      setPermissionStatus(null);
      setPermissionRequestError(null);
    } catch (error) {
      console.error("Failed to finish overlay enable flow:", error);
      setPermissionRequestError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setActivePermissionRequest(null);
      setIsRequestingPermissions(false);
    }
  }

  function startHotkeyRecording() {
    if (controlsDisabled) {
      return;
    }
    setIsRecordingHotkey(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }

  function stopHotkeyRecording() {
    setIsRecordingHotkey(false);
  }

  async function handleHotkeyKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
  ) {
    if (!isRecordingHotkey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key === "Escape"
    ) {
      stopHotkeyRecording();
      inputRef.current?.blur();
      return;
    }

    const hotkey = formatHotkeyFromEvent(event);
    if (!hotkey) {
      return;
    }

    stopHotkeyRecording();
    inputRef.current?.blur();
    await saveSettings({ ...settingsState, hotkey });
  }

  if (loading) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  const isPermissionStatusLoading =
    showPermissionSetup && permissionStatus === null;
  const nextMissingPermission = permissionStatus
    ? getNextMissingOverlayPermission(permissionStatus, {
        requiresAccessibility: requiresAccessibilityPermission,
      })
    : null;
  const isReadyToEnable =
    permissionStatus !== null && nextMissingPermission === null;

  let primaryActionLabel = requiresAccessibilityPermission
    ? "Enable Accessibility"
    : "Allow Screen Capture";
  if (isPermissionStatusLoading) {
    primaryActionLabel = requiresAccessibilityPermission
      ? "Checking permissions..."
      : "Checking screen capture...";
  } else if (nextMissingPermission === "screen-recording") {
    primaryActionLabel =
      requiresAccessibilityPermission
      && permissionStatus?.screenRecordingStatus === "denied"
        ? "Open Screen Recording Settings"
        : requiresAccessibilityPermission
          ? "Enable Screen Recording"
          : "Allow Screen Capture";
  } else if (isReadyToEnable) {
    primaryActionLabel = "Enable Overlay";
  }

  let activeActionLabel = "Working...";
  if (activePermissionRequest === "accessibility") {
    activeActionLabel = "Waiting for Accessibility permission...";
  } else if (activePermissionRequest === "screen-recording") {
    activeActionLabel = requiresAccessibilityPermission
      ? "Waiting for Screen Recording permission..."
      : isLinuxPlatform
        ? "Waiting for screen-share approval..."
        : "Verifying screen capture...";
  } else if (activePermissionRequest === "enable") {
    activeActionLabel = "Finishing Overlay setup...";
  }

  const accessibilityStepState: "completed" | "in-progress" | "pending" =
    permissionStatus?.accessibilityGranted
      ? "completed"
      : activePermissionRequest === "accessibility"
        ? "in-progress"
        : "pending";
  const screenRecordingStepState: "completed" | "in-progress" | "pending" =
    permissionStatus?.screenRecordingGranted
      ? "completed"
      : activePermissionRequest === "screen-recording"
        ? "in-progress"
        : "pending";

  function renderPermissionCard({
    title,
    description,
    detail,
    state,
  }: {
    title: string;
    description: string;
    detail: string;
    state: "completed" | "in-progress" | "pending";
  }) {
    return (
      <div
        className="rounded-[18px] p-4"
        style={{
          border:
            "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 76%, transparent)",
          background:
            state === "completed"
              ? "linear-gradient(180deg, color-mix(in srgb, var(--oa-bg-subtle) 72%, var(--card) 28%) 0%, color-mix(in srgb, var(--card) 96%, transparent) 100%)"
              : "linear-gradient(180deg, color-mix(in srgb, var(--card) 95%, var(--oa-bg-subtle) 5%) 0%, color-mix(in srgb, var(--card) 99%, transparent) 100%)",
        }}
      >
        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <p className="text-ui-sm font-medium text-foreground">{title}</p>
              {state === "completed" ? (
                <CheckCircle2 className="size-4 shrink-0 text-foreground" />
              ) : null}
            </div>
          <p className="text-ui-sm leading-6 text-muted-foreground">
            {description}
          </p>
            <p className="text-ui-sm text-muted-foreground">{detail}</p>
          </div>
        </div>
      </div>
    );
  }

  function handlePrimaryPermissionAction() {
    if (isPermissionStatusLoading || !permissionStatus) {
      return;
    }

    if (!permissionStatus.accessibilityGranted) {
      void runPermissionRequest("accessibility", () =>
        overlaySettings.requestAccessibilityPermission(),
      );
      return;
    }

    if (!permissionStatus.screenRecordingGranted) {
      void runPermissionRequest("screen-recording", () =>
        overlaySettings.requestScreenRecordingPermission(),
      );
      return;
    }

    void finishOverlayEnable();
  }

  return (
    <>
      <AlertDialog
        open={showPermissionSetup}
        onOpenChange={(open) => {
          if (open) {
            setShowPermissionSetup(true);
            return;
          }

          void cancelPermissionSetup();
        }}
      >
        <AlertDialogContent
          size="lg"
          className="gap-0 overflow-hidden p-0"
          overlayClassName="backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        >
          <AlertDialogHeader
            className="gap-5 px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--oa-bg-subtle) 28%, transparent) 0%, transparent 64%)",
            }}
          >
            <div
              className="rounded-[20px] p-5 sm:p-6"
              style={{
                border:
                  "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 78%, transparent)",
                background:
                  "linear-gradient(135deg, color-mix(in srgb, var(--oa-bg-subtle) 56%, var(--card) 44%) 0%, color-mix(in srgb, var(--card) 96%, transparent) 100%)",
              }}
            >
              <div className="min-w-0 space-y-2">
                <AlertDialogTitle className="text-[18px] leading-6">
                  {isReadyToEnable
                    ? "Finish Overlay setup"
                    : requiresAccessibilityPermission
                      ? "Set up Overlay"
                      : "Allow Screen Capture"}
                </AlertDialogTitle>
                <AlertDialogDescription className="max-w-[34rem] text-pretty">
                  {isReadyToEnable
                    ? "Overlay has the system access it needs. Turn it on now, then use the global shortcut right away."
                    : requiresAccessibilityPermission
                      ? "Interpreter needs system access before Overlay can work in other apps. Grant both permissions, then finish setup."
                      : isLinuxPlatform
                        ? "Interpreter needs screen-capture access from your desktop environment before Overlay can work in other apps. Approve the screen-share prompt, then finish setup."
                        : "Interpreter needs to verify that screen capture works in this Windows session before Overlay can be enabled."}
                </AlertDialogDescription>
                <p className="text-ui-sm text-muted-foreground">
                  {isReadyToEnable
                    ? requiresAccessibilityPermission
                      ? "Both permissions are granted."
                      : "Screen capture is ready."
                    : requiresAccessibilityPermission
                      ? "Two permissions are still required."
                      : "Screen capture approval is still required."}
                </p>
              </div>
            </div>
            {isPermissionStatusLoading && (
              <div
                className="rounded-[16px] px-4 py-3 text-ui-sm text-muted-foreground"
                style={{
                  border:
                    "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 70%, transparent)",
                  background:
                    "color-mix(in srgb, var(--card) 90%, var(--oa-bg-subtle) 10%)",
                }}
              >
                Checking system permission status...
              </div>
            )}
            {!isPermissionStatusLoading && (
              <div
                className={cn(
                  "grid gap-3",
                  requiresAccessibilityPermission && "sm:grid-cols-2",
                )}
              >
                {requiresAccessibilityPermission ? renderPermissionCard({
                  title: "Accessibility",
                  description:
                    "Allows Overlay to click and type in other apps.",
                  detail: `Status: ${permissionStatus?.accessibilityGranted ? "Granted" : "Not granted"}`,
                  state: accessibilityStepState,
                }) : null}
                {renderPermissionCard({
                  title: screenCaptureLabel,
                  description:
                    requiresAccessibilityPermission
                      ? "Allows Overlay to understand what is visible on screen."
                      : isLinuxPlatform
                        ? "Allows Overlay to understand what is visible on screen. Your desktop environment may show a screen-share prompt."
                        : "Verifies that Overlay can capture what is visible on screen in this Windows session.",
                  detail: permissionStatus?.screenRecordingGranted
                    ? "Status: Granted"
                    : `Status: Not granted (${getScreenRecordingPermissionDetail(permissionStatus?.screenRecordingStatus ?? "unknown")})`,
                  state: screenRecordingStepState,
                })}
              </div>
            )}
            {permissionRequestError && (
              <p
                className="rounded-[16px] px-4 py-3 text-ui-sm leading-6 text-foreground"
                style={{
                  border:
                    "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 74%, transparent)",
                  background:
                    "color-mix(in srgb, var(--card) 88%, var(--oa-bg-subtle) 12%)",
                }}
              >
                {permissionRequestError}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter className="px-6 pb-5 sm:px-7 sm:pb-6">
            <Button
              variant="secondary"
              className="sm:min-w-[9.5rem]"
              onClick={() => {
                void cancelPermissionSetup();
              }}
              disabled={isRequestingPermissions}
            >
              Cancel
            </Button>
            <Button
              onClick={handlePrimaryPermissionAction}
              className="sm:min-w-[12rem]"
              disabled={isRequestingPermissions || isPermissionStatusLoading}
            >
              {isRequestingPermissions ? activeActionLabel : primaryActionLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-3 py-[18px]">
        {settingsLocked ? (
          <SettingsCard
            tone="muted"
            className="rounded-[16px] px-4 py-4 sm:px-5"
            style={{
              borderWidth: "var(--border-width)",
              borderColor:
                "color-mix(in srgb, var(--oa-border, var(--border)) 72%, transparent)",
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--card) 96%, var(--oa-bg-subtle) 4%) 0%, var(--card) 100%)",
            }}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-[10px] text-foreground"
                    style={{
                      border:
                        "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 74%, transparent)",
                      background:
                        "color-mix(in srgb, var(--oa-bg-subtle) 38%, var(--card) 62%)",
                    }}
                  >
                    <LockKeyhole className="size-4" aria-hidden="true" />
                  </span>
                  <div className="text-ui-sm font-medium leading-6 text-foreground">
                    Upgrade to unlock Interpreter Overlay
                  </div>
                </div>
                <div className="mt-3 max-w-2xl space-y-2 text-ui-sm leading-6 text-muted-foreground text-pretty">
                  <p>
                    Overlay lets Interpreter work from a global shortcut, read the active screen,
                    and help fill forms or operate desktop apps without opening the main window.
                  </p>
                  <p>
                    It is available on paid plans. The shortcut and form-filling requests stay off
                    until this account has an active paid subscription.
                  </p>
                </div>
              </div>
              <div className="flex w-full justify-start sm:w-auto sm:justify-end">
                <Button
                  type="button"
                  onClick={() => void handleOverlayUpgrade()}
                  disabled={isOpeningCheckout}
                  className="gap-2"
                >
                  {isOpeningCheckout ? "Opening checkout..." : "Upgrade to unlock"}
                  {!isOpeningCheckout ? <ExternalLink className="size-4" aria-hidden="true" /> : null}
                </Button>
              </div>
            </div>
          </SettingsCard>
        ) : null}

        <SettingsCard
          tone="muted"
          className={cn(
            "rounded-[16px] px-4 py-4 sm:px-5",
            controlsDisabled && "opacity-50",
          )}
          style={controlCardStyle}
          data-help-title={t("settings.overlay.enableLabel")}
          data-help-description={t("settings.overlay.enableDescription")}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <div className="text-ui-sm font-medium leading-6 text-foreground">
                {t("settings.overlay.enableLabel")}
              </div>
              <div className="mt-1 max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
                {t("settings.overlay.enableDescription")}
              </div>
            </div>
            <div className="flex w-full justify-start sm:w-auto sm:justify-end">
              <Switch
                checked={settingsState.enabled}
                disabled={controlsDisabled}
                onCheckedChange={(enabled) => void handleEnableToggle(enabled)}
              />
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          tone="muted"
          className={cn(
            "rounded-[16px] px-4 py-4 sm:px-5",
            controlsDisabled && "opacity-50",
          )}
          style={controlCardStyle}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <div className="text-ui-sm font-medium leading-6 text-foreground">
                Hidden agent model
              </div>
              <div className="mt-1 max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
                Choose the fast model used when Overlay delegates a bounded task to a hidden agent.
              </div>
            </div>
            <div className="w-full sm:max-w-[20rem]">
              <Select
                value={hiddenAgentModelValue}
                disabled={controlsDisabled}
                onValueChange={(hiddenAgentModel) => void saveSettings({
                  ...settingsState,
                  hiddenAgentModel,
                })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent align="start" position="popper">
                  {voiceProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
                  {!hasProfileModelValue(voiceProfiles, hiddenAgentModelValue) && (
                    <SelectItem value={hiddenAgentModelValue}>
                      {hiddenAgentModelValue}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          tone="muted"
          className={cn(
            "rounded-[16px] px-4 py-4 sm:px-5",
            controlsDisabled && "opacity-50",
          )}
          style={controlCardStyle}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <div className="text-ui-sm font-medium leading-6 text-foreground">
                Typed overlay model
              </div>
              <div className="mt-1 max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
                Choose the model used when you type into the Overlay.
              </div>
            </div>
            <div className="w-full sm:max-w-[20rem]">
              <Select
                value={overlayTextProfileValue}
                disabled={controlsDisabled}
                onValueChange={(value) => void saveSettings({
                  ...settingsState,
                  preferredProfileId: value === OVERLAY_TEXT_DEFAULT_PROFILE_VALUE ? null : value,
                })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent align="start" position="popper">
                  <SelectItem value={OVERLAY_TEXT_DEFAULT_PROFILE_VALUE}>
                    App default
                  </SelectItem>
                  {voiceProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
                  {settingsState.preferredProfileId
                    && !voiceProfiles.some((profile) => profile.id === settingsState.preferredProfileId)
                    && (
                      <SelectItem value={settingsState.preferredProfileId}>
                        {settingsState.preferredProfileId}
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          tone="muted"
          className={cn(
            "rounded-[16px] px-4 py-4 sm:px-5",
            controlsDisabled && "opacity-50",
          )}
          style={controlCardStyle}
        >
          <div className="space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div className="min-w-0 flex-1">
                <div className="text-ui-sm font-medium leading-6 text-foreground">
                  Advanced voice mode
                </div>
                <div className="mt-1 max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
                  Hold the Overlay shortcut to talk with a desktop agent through Realtime voice. Turn this off to use dictation into the prompt instead.
                </div>
              </div>
              <div className="flex w-full justify-start sm:w-auto sm:justify-end">
                <Switch
                  checked={settingsState.advancedVoiceEnabled}
                  disabled={controlsDisabled}
                  onCheckedChange={(advancedVoiceEnabled) => void saveSettings({
                    ...settingsState,
                    advancedVoiceEnabled,
                  })}
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <div className="text-ui-sm font-medium leading-6 text-foreground">
                  Voice agent model
                </div>
                <Select
                  value={advancedVoiceModelValue}
                  disabled={controlsDisabled || !settingsState.advancedVoiceEnabled}
                  onValueChange={(advancedVoiceModel) => void saveSettings({
                    ...settingsState,
                    advancedVoiceModel,
                  })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent align="start" position="popper">
                    {voiceProfiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                      </SelectItem>
                    ))}
                    {!hasProfileModelValue(voiceProfiles, advancedVoiceModelValue) && (
                      <SelectItem value={advancedVoiceModelValue}>
                        {advancedVoiceModelValue}
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-2">
                <div className="text-ui-sm font-medium leading-6 text-foreground">
                  Voice workspace
                </div>
                <Select
                  value={advancedVoiceWorkspaceValue}
                  disabled={controlsDisabled || !settingsState.advancedVoiceEnabled}
                  onValueChange={(value) => void saveSettings({
                    ...settingsState,
                    advancedVoiceWorkspacePath: value === ADVANCED_VOICE_DESKTOP_WORKSPACE_VALUE ? null : value,
                  })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a workspace" />
                  </SelectTrigger>
                  <SelectContent align="start" position="popper">
                    <SelectItem value={ADVANCED_VOICE_DESKTOP_WORKSPACE_VALUE}>
                      Desktop
                    </SelectItem>
                    {recentWorkspaces.map((workspace) => (
                      <SelectItem key={workspace.path} value={workspace.path}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          tone="muted"
          className={cn(
            "rounded-[16px] px-4 py-4 sm:px-5",
            controlsDisabled && "opacity-50",
          )}
          style={controlCardStyle}
          data-help-title={t("settings.overlay.hotkeyLabel")}
          data-help-description={t("settings.overlay.hotkeyDescription")}
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
            <div className="min-w-0 flex-1">
              <div className="text-ui-sm font-medium leading-6 text-foreground">
                {t("settings.overlay.hotkeyLabel")}
              </div>
              <div className="mt-1 max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
                {t("settings.overlay.hotkeyDescription")}
              </div>
            </div>
            <div className="grid w-full items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:max-w-[23rem]">
              <Input
                ref={inputRef}
                readOnly
                value={
                  isRecordingHotkey
                    ? t("settings.overlay.hotkeyRecordingValue")
                    : settingsState.hotkey
                }
                onFocus={startHotkeyRecording}
                onBlur={stopHotkeyRecording}
                onKeyDown={(event) => void handleHotkeyKeyDown(event)}
                aria-label={t("settings.overlay.hotkeyLabel")}
                disabled={controlsDisabled}
                className="min-w-0 text-center font-medium tracking-[-0.01em] tabular-nums"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={startHotkeyRecording}
                disabled={controlsDisabled}
                className="max-sm:justify-self-start"
              >
                {isRecordingHotkey
                  ? t("settings.overlay.hotkeyRecordingButton")
                  : t("settings.overlay.hotkeyChangeButton")}
              </Button>
            </div>
          </div>
        </SettingsCard>
      </div>
    </>
  );
}

export function OverlaySectionIntroContent() {
  const { t } = useTranslation();
  const { openSettings } = useLayoutActions();

  return (
    <div className="py-[18px]">
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="text-ui-sm font-medium text-foreground">
            Interpreter Overlay
          </div>
          <span
            className="rounded-full px-2 py-0.5 text-ui-xs font-medium text-muted-foreground"
            style={{ border: "var(--border-width) solid var(--border)" }}
          >
            Experimental
          </span>
        </div>
        <p className="text-ui-sm leading-6 text-muted-foreground text-pretty">
          {t("settings.overlay.blurbPrimary")}
        </p>
        <p className="text-ui-sm leading-6 text-muted-foreground text-pretty">
          {t("settings.overlay.blurbSecondary")}
        </p>
        <SettingsCard tone="muted" className="max-w-[560px]">
          <p className="text-ui-sm leading-6 text-muted-foreground text-pretty">
            <Trans
              i18nKey="settings.overlay.serverNotice"
              components={{
                privacyLink: (
                  <button
                    type="button"
                    className="inline font-medium text-foreground underline decoration-[color-mix(in_srgb,var(--foreground)_22%,transparent)] underline-offset-2 transition-colors hover:text-foreground/80"
                    onClick={() => {
                      void openExternal(
                        "https://www.openinterpreter.com/legal/privacy",
                      );
                    }}
                  />
                ),
                telemetryLink: (
                  <button
                    type="button"
                    className="inline font-medium text-foreground underline decoration-[color-mix(in_srgb,var(--foreground)_22%,transparent)] underline-offset-2 transition-colors hover:text-foreground/80"
                    onClick={() => openSettings(undefined, "telemetry")}
                  />
                ),
              }}
            />
          </p>
        </SettingsCard>
      </div>
    </div>
  );
}
