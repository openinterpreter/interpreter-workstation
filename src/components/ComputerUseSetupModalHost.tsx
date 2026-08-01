import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  Monitor,
  MousePointer2,
  ShieldCheck,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { computerUseSetup, getRuntimeSystemInfo, overlaySettings } from "@/ipc";
import { cn } from "@/lib/utils";

type ScreenRecordingStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

interface PermissionStatus {
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  screenRecordingStatus: ScreenRecordingStatus;
}

type PermissionStep = "accessibility" | "screen-recording";

const PENDING_STORAGE_KEY = "interpreter.computerUseSetup.pending";

function hasAllPermissions(status: PermissionStatus | null): boolean {
  return Boolean(status?.accessibilityGranted && status.screenRecordingGranted);
}

function screenRecordingDetail(status: ScreenRecordingStatus | undefined): string {
  switch (status) {
    case "granted":
      return "Granted";
    case "not-determined":
      return "Not requested yet";
    case "denied":
      return "Needs System Settings";
    case "restricted":
      return "Restricted by macOS";
    default:
      return "Checking";
  }
}

function useIsMac(): boolean {
  return getRuntimeSystemInfo().platform === "darwin";
}

export function ComputerUseSetupModalHost() {
  "use no memo";

  const isMac = useIsMac();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const [activeStep, setActiveStep] = useState<PermissionStep | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = hasAllPermissions(status);

  const refreshStatus = useCallback(async (options?: { surfaceErrors?: boolean }) => {
    if (!isMac) return null;

    try {
      const response = await overlaySettings.getPermissionStatus();
      setStatus(response.status);
      if (hasAllPermissions(response.status)) {
        window.localStorage.removeItem(PENDING_STORAGE_KEY);
      }
      return response.status;
    } catch (refreshError) {
      if (options?.surfaceErrors) {
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      }
      return null;
    }
  }, [isMac]);

  const openSetup = useCallback(() => {
    if (!isMac) return;
    window.localStorage.setItem(PENDING_STORAGE_KEY, "true");
    setError(null);
    void (async () => {
      const latest = await refreshStatus({ surfaceErrors: true });
      if (hasAllPermissions(latest)) {
        await computerUseSetup.ready();
        return;
      }
      setOpen(true);
    })();
  }, [isMac, refreshStatus]);

  useEffect(() => {
    if (!isMac) return;

    const unsubscribe = computerUseSetup.onRequested(() => {
      openSetup();
    });

    return unsubscribe;
  }, [isMac, openSetup]);

  useEffect(() => {
    if (!isMac) return;

    const unsubscribe = computerUseSetup.onStatusRequested((event) => {
      void (async () => {
        const response = await overlaySettings.getPermissionStatus();
        await computerUseSetup.reportStatus(event.requestId, response.status);
      })().catch((statusError) => {
        console.warn("[ComputerUseSetup] Failed to report permission status", statusError);
      });
    });

    return unsubscribe;
  }, [isMac]);

  useEffect(() => {
    if (!isMac) return;
    if (window.localStorage.getItem(PENDING_STORAGE_KEY) !== "true") return;

    void (async () => {
      const latest = await refreshStatus();
      if (!hasAllPermissions(latest)) {
        setOpen(true);
      }
    })();
  }, [isMac, refreshStatus]);

  useEffect(() => {
    if (!ready) return;
    void computerUseSetup.ready().catch((readyError) => {
      setError(readyError instanceof Error ? readyError.message : String(readyError));
    });
  }, [ready]);

  useEffect(() => {
    if (!open || !isMac) return;

    let disposed = false;
    let inFlight = false;

    async function poll() {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        await refreshStatus();
      } finally {
        inFlight = false;
      }
    }

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [isMac, open, refreshStatus]);

  async function requestPermission(step: PermissionStep) {
    setActiveStep(step);
    setError(null);

    try {
      const response = step === "accessibility"
        ? await overlaySettings.requestAccessibilityPermission()
        : await overlaySettings.requestScreenRecordingPermission();

      setStatus(response.status);
      if (!response.success && response.error) {
        setError(response.error);
      }

      if (step === "accessibility" && !response.status.accessibilityGranted) {
        await overlaySettings.openAccessibilitySettings();
      }
      if (step === "screen-recording" && !response.status.screenRecordingGranted) {
        await overlaySettings.openScreenRecordingSettings();
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setActiveStep(null);
      void refreshStatus();
    }
  }

  async function checkAgain() {
    setActiveStep("check");
    setError(null);
    try {
      await refreshStatus({ surfaceErrors: true });
    } finally {
      setActiveStep(null);
    }
  }

  const nextStep = useMemo<PermissionStep | null>(() => {
    if (!status) return null;
    if (!status.accessibilityGranted) return "accessibility";
    if (!status.screenRecordingGranted) return "screen-recording";
    return null;
  }, [status]);

  if (!isMac) return null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen && ready) {
          window.localStorage.removeItem(PENDING_STORAGE_KEY);
        }
      }}
    >
      <AlertDialogContent
        size="lg"
        className="gap-0 overflow-hidden p-0"
        data-testid="computer-use-setup-modal"
      >
        <AlertDialogHeader className="gap-5 px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
          <div
            className="rounded-lg p-5"
            style={{
              border:
                "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 78%, transparent)",
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--card) 92%, var(--oa-bg-subtle) 8%) 0%, var(--card) 100%)",
            }}
          >
            <div className="flex items-start gap-4">
              <div
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground"
                style={{
                  border:
                    "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 76%, transparent)",
                  background:
                    "color-mix(in srgb, var(--oa-bg-subtle) 78%, var(--card) 22%)",
                }}
              >
                <ShieldCheck className="size-5" />
              </div>
              <div className="min-w-0 space-y-2">
                <AlertDialogTitle className="text-[18px] leading-6">
                  Computer Use Setup
                </AlertDialogTitle>
                <AlertDialogDescription className="max-w-[36rem] text-pretty">
                  Interpreter needs two macOS permissions before it can use other apps for you.
                  Keep this window open while System Settings is open; Interpreter will check
                  automatically and continue when both items are granted.
                </AlertDialogDescription>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <PermissionCard
              icon={<MousePointer2 className="size-4" />}
              title="Accessibility"
              description="Lets Interpreter inspect app controls, then click and type only when you approve computer use."
              detail={status?.accessibilityGranted ? "Status: Granted" : "Status: Not granted"}
              completed={Boolean(status?.accessibilityGranted)}
              active={activeStep === "accessibility"}
            />
            <PermissionCard
              icon={<Monitor className="size-4" />}
              title="Screen Recording"
              description="Lets Interpreter verify what is visible on screen while it works in native apps."
              detail={`Status: ${status?.screenRecordingGranted ? "Granted" : screenRecordingDetail(status?.screenRecordingStatus)}`}
              completed={Boolean(status?.screenRecordingGranted)}
              active={activeStep === "screen-recording"}
            />
          </div>

          <div
            className="rounded-lg px-4 py-3 text-ui-sm leading-6 text-muted-foreground"
            style={{
              border:
                "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 70%, transparent)",
              background:
                "color-mix(in srgb, var(--card) 92%, var(--oa-bg-subtle) 8%)",
            }}
          >
            macOS may say an app must quit and reopen after Screen Recording changes.
            Interpreter keeps setup mode active so the flow resumes after the app comes back.
          </div>

          {error ? (
            <p
              className="rounded-lg px-4 py-3 text-ui-sm leading-6 text-foreground"
              style={{
                border:
                  "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 74%, transparent)",
                background:
                  "color-mix(in srgb, var(--card) 88%, var(--oa-bg-subtle) 12%)",
              }}
            >
              {error}
            </p>
          ) : null}
        </AlertDialogHeader>

        <AlertDialogFooter className="px-6 pb-5 sm:px-7 sm:pb-6">
          <Button variant="secondary" onClick={checkAgain} disabled={activeStep !== null}>
            {activeStep === "check" ? "Checking..." : "Check Again"}
          </Button>
          {!ready && nextStep ? (
            <Button onClick={() => void requestPermission(nextStep)} disabled={activeStep !== null}>
              <Settings className="mr-2 size-4" />
              {activeStep === nextStep
                ? nextStep === "accessibility"
                  ? "Opening Accessibility..."
                  : "Opening Screen Recording..."
                : nextStep === "accessibility"
                  ? "Open Accessibility Settings"
                  : "Open Screen Recording Settings"}
            </Button>
          ) : (
            <Button
              onClick={() => {
                window.localStorage.removeItem(PENDING_STORAGE_KEY);
                setOpen(false);
              }}
              disabled={!ready || activeStep !== null}
            >
              Done
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PermissionCard({
  icon,
  title,
  description,
  detail,
  completed,
  active,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  detail: string;
  completed: boolean;
  active: boolean;
}) {
  return (
    <div
      className={cn("rounded-lg p-4", active && "opacity-90")}
      style={{
        border:
          "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 74%, transparent)",
        background:
          completed
            ? "color-mix(in srgb, var(--oa-bg-subtle) 62%, var(--card) 38%)"
            : "color-mix(in srgb, var(--card) 94%, var(--oa-bg-subtle) 6%)",
      }}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-foreground">{icon}</div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <p className="text-ui-sm font-medium text-foreground">{title}</p>
            {active ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : completed ? (
              <CheckCircle2 className="size-4 text-foreground" />
            ) : (
              <Circle className="size-4 text-muted-foreground" />
            )}
          </div>
          <p className="text-ui-sm leading-6 text-muted-foreground">{description}</p>
          <p className="text-ui-sm text-muted-foreground">{detail}</p>
        </div>
      </div>
    </div>
  );
}
