import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  AudioLines,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  Settings2,
  X,
} from "lucide-react";
import { animate, motion, useDragControls, useMotionValue } from "motion/react";
import { AgentThread } from "../../../agent/components/AgentThread";
import { ComposerArea } from "../../../agent/components/ComposerArea";
import type { BaseTiptapComposerRef } from "../../../agent/components/composer/BaseTiptapComposer";
import { AgentMetadataProvider } from "../../../agent/contexts/AgentMetadataContext";
import { AgentErrorProvider } from "../../../agent/contexts/AgentErrorContext";
import { getProfiles, setDefaultProfile } from "../../api";
import { createAgentCallerToken } from "../../utils/layoutHelpers";
import {
  getDefaultModelConfig,
  isTerminalProfile,
  profileToModelConfig,
  type Profile,
} from "../../../shared/types/profile";
import type { AgentModelConfig } from "../../../shared/types/model";
import {
  isRemoteWorkstationHost,
  isWorkstationReadOnly,
} from "../../remote/workstationConnection";
import { ExperienceSectionContent } from "../settings/ExperienceSection";
import { ProfilesSectionContent } from "../settings/ProfilesSection";
import {
  openFolderDialog,
  profiles as profilesIpc,
  quickActions,
  simplePrimaryThread,
  simpleComposerState,
  windowIpc,
} from "@/ipc";
import { useSimpleLive } from "./useSimpleLive";
import { SimpleConnectionsSettings } from "./SimpleConnectionsSettings";
import {
  simpleInterfaceClient,
  type SimplePresentation,
  type SimpleProject,
} from "./simpleInterfaceClient";

/** A fixed identity names the one conversation even when the shell is remounted. */
export const SIMPLE_PRIMARY_AGENT_ID = "simple-primary-agent";

type SimpleSurfaceMode =
  | "compact"
  | "conversation"
  | "presentation"
  | "settings";
type SimpleSettingsView = "main" | "models";
type SimpleModelStatus = "loading" | "ready" | "missing" | "error";

export function sendSimpleMessage(
  text: string,
  workspacePath: string,
  source?: string,
): void {
  if (!text.trim()) throw new Error("A message is required.");
  if (
    document.querySelector(
      '[data-simple-shell][data-primary-thread-error="true"]',
    )
  ) {
    throw new Error(
      "The primary conversation needs recovery before another message can be sent.",
    );
  }
  let accepted = false;
  window.dispatchEvent(
    new CustomEvent("agent-runtime:get-state", {
      detail: {
        tabId: SIMPLE_PRIMARY_AGENT_ID,
        callback: () => {
          accepted = true;
        },
      },
    }),
  );
  if (!accepted)
    throw new Error(
      "The primary conversation is not ready. Try again shortly.",
    );
  const attributedText = source?.trim()
    ? `[From ${source.trim()}]\n${text}`
    : text;
  window.dispatchEvent(
    new CustomEvent("agent-runtime:send", {
      detail: {
        tabId: SIMPLE_PRIMARY_AGENT_ID,
        text: attributedText,
        workspacePath,
        messageSource: source,
      },
    }),
  );
}

interface SimpleShellProps {
  workspacePath: string;
  initialThreadId: string | null;
  onBindThread: (threadId: string) => void | Promise<void>;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  canvas: ReactNode;
}

/** Simple is a separate surface: no explorer, tabs, sidebars, or second-chat affordances. */
export function SimpleShell({
  workspacePath,
  initialThreadId,
  onBindThread,
  onOpenSettings,
  settingsOpen,
  onCloseSettings,
  canvas,
}: SimpleShellProps) {
  const remoteWorkstation = isRemoteWorkstationHost();
  const [surfaceMode, setSurfaceMode] = useState<SimpleSurfaceMode>(
    settingsOpen ? "settings" : "compact",
  );
  const [lastExpandedSurfaceMode, setLastExpandedSurfaceMode] = useState<
    Exclude<SimpleSurfaceMode, "compact">
  >(settingsOpen ? "settings" : "conversation");
  const [settingsView, setSettingsView] = useState<SimpleSettingsView>("main");
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  const [modelConfig, setModelConfig] = useState<AgentModelConfig>(
    getDefaultModelConfig,
  );
  const [modelStatus, setModelStatus] = useState<SimpleModelStatus>("loading");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null,
  );
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelPending, setModelPending] = useState(false);
  const [project, setProject] = useState<SimpleProject | null>(null);
  const [recentProjects, setRecentProjects] = useState<SimpleProject[]>([]);
  const [projectPending, setProjectPending] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<SimplePresentation | null>(
    null,
  );
  const [presentationImageUrl, setPresentationImageUrl] = useState<
    string | null
  >(null);
  const seenPresentationId = useRef<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activitySummary, setActivitySummary] = useState("Ready");
  const [messageCount, setMessageCount] = useState(0);
  const [persistenceError, setPersistenceError] = useState(false);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [ownsComposer, setOwnsComposer] = useState(true);
  const composerRef = useRef<BaseTiptapComposerRef>(null);
  const [initialDraft, setInitialDraft] = useState("");
  const dragBoundsRef = useRef<HTMLDivElement | null>(null);
  const dragControls = useDragControls();
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const callerToken = useMemo(() => createAgentCallerToken(), []);
  const readOnly = isWorkstationReadOnly();
  const handleLiveDelegate = useCallback(
    (text: string) => {
      window.dispatchEvent(
        new CustomEvent("agent-runtime:send", {
          detail: {
            tabId: SIMPLE_PRIMARY_AGENT_ID,
            text: `[From GPT Live]\n${text}`,
            workspacePath,
          },
        }),
      );
    },
    [workspacePath],
  );
  const live = useSimpleLive({ onDelegate: handleLiveDelegate });

  useEffect(() => {
    setThreadId(initialThreadId);
  }, [initialThreadId]);

  useEffect(() => {
    if (typeof windowIpc.onFocusChanged !== "function") return;
    return windowIpc.onFocusChanged(({ focused }: { focused: boolean }) =>
      setOwnsComposer(focused),
    );
  }, []);

  useEffect(() => {
    let alive = true;
    void simpleComposerState
      .get()
      .then(({ draft }) => {
        if (!alive) return;
        setInitialDraft(draft);
        composerRef.current?.setContent(draft);
      })
      .catch(() => {
        /* Older desktop/browser hosts may not expose the optional draft bridge yet. */
      });
    let unsubscribe = () => {};
    try {
      unsubscribe = simpleComposerState.onChanged(({ draft }) => {
        setInitialDraft(draft);
        if (composerRef.current?.getContent() !== draft)
          composerRef.current?.setContent(draft);
      });
    } catch {
      /* Keep the local composer usable if the host has not restarted its preload yet. */
    }
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const persistComposerDraft = useCallback((draft: string) => {
    void simpleComposerState.set({ draft }).catch(() => {
      /* Draft syncing is a handoff enhancement; sending locally must remain available. */
    });
  }, []);

  useEffect(() => {
    if (settingsOpen) setSurfaceMode("settings");
    else
      setSurfaceMode((current) =>
        current === "settings" ? "compact" : current,
      );
  }, [settingsOpen]);

  useEffect(
    () =>
      simplePrimaryThread.onOverlaySubmit(({ text, interfacePath }) => {
        try {
          sendSimpleMessage(
            text,
            workspacePath,
            interfacePath
              ? `desktop overlay while viewing ${interfacePath}`
              : "desktop overlay",
          );
          setOverlayError(null);
        } catch (error) {
          setOverlayError(
            error instanceof Error
              ? error.message
              : "Could not send from the overlay.",
          );
          setSurfaceMode("conversation");
        }
      }),
    [workspacePath],
  );

  const loadProfiles = useCallback(async (preferredProfile?: Profile) => {
    setModelStatus("loading");
    try {
      const data = await getProfiles();
      const availableProfiles = data.profiles.filter(
        (profile) => !isTerminalProfile(profile),
      );
      const selected =
        preferredProfile ??
        availableProfiles.find(
          (profile) => profile.id === data.defaultProfileId,
        ) ??
        availableProfiles[0];
      setProfiles(availableProfiles);
      setSelectedProfileId(selected?.id ?? null);
      if (!selected) {
        setModelStatus("missing");
        return;
      }
      // Simple mode follows the selected profile's own speed/reasoning choice.
      // The general workspace deliberately supplies its reasoning preference
      // separately, but Simple has no separate reasoning control; dropping this
      // value made a profile labelled "fast" run at the model default instead.
      setModelConfig(
        profileToModelConfig(selected, {
          reasoningEffort: selected.reasoningEffort,
        }),
      );
      setModelStatus("ready");
    } catch (error) {
      console.error("[SimpleShell] Could not load model profiles", error);
      setModelStatus("error");
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
    const offChanged = profilesIpc.onChanged?.(() => {
      void loadProfiles();
    });
    const offDefaultChanged = profilesIpc.onDefaultChanged?.(() => {
      void loadProfiles();
    });
    return () => {
      offChanged?.();
      offDefaultChanged?.();
    };
  }, [loadProfiles]);

  const loadProjects = useCallback(async () => {
    const result = await simpleInterfaceClient.projects();
    setProject(result.active);
    setRecentProjects(result.recent);
  }, []);

  useEffect(() => {
    void loadProjects().catch((error) =>
      setProjectError(
        error instanceof Error ? error.message : "Could not load interfaces.",
      ),
    );
  }, [loadProjects]);

  useEffect(() => {
    let stopped = false;
    const refreshPresentation = async () => {
      try {
        const next = await simpleInterfaceClient.presentation();
        if (stopped) return;
        setPresentation(next);
        setPresentationImageUrl(
          next?.asset ? await simpleInterfaceClient.assetUrl(next.asset) : null,
        );
        if (next && next.id !== seenPresentationId.current) {
          seenPresentationId.current = next.id;
          setSurfaceMode("presentation");
        }
      } catch {
        /* Presentation is an enhancement; chat remains usable if it is unavailable. */
      }
    };
    void refreshPresentation();
    const timer = window.setInterval(() => {
      void refreshPresentation();
    }, 750);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  const chooseProjectFolder = useCallback(
    async (mode: "new" | "open") => {
      if (projectPending || readOnly) return;
      setProjectPending(true);
      setProjectError(null);
      try {
        const selection = await openFolderDialog();
        const path = selection.filePaths[0];
        if (selection.canceled || !path) return;
        const next =
          mode === "new"
            ? await simpleInterfaceClient.createProject(path, {
                activate: false,
              })
            : await simpleInterfaceClient.openProject(path, {
                activate: false,
              });
        const opened = await windowIpc.create({
          workspacePath,
          simpleProjectPath: next.path,
        });
        if (!opened.success)
          throw new Error(
            opened.error || "Could not open the interface window.",
          );
        await loadProjects();
      } catch (error) {
        setProjectError(
          error instanceof Error
            ? error.message
            : `Could not ${mode} the interface.`,
        );
      } finally {
        setProjectPending(false);
      }
    },
    [loadProjects, projectPending, readOnly, workspacePath],
  );

  const reopenProject = useCallback(
    async (path: string) => {
      if (projectPending || readOnly) return;
      setProjectPending(true);
      setProjectError(null);
      try {
        const next = await simpleInterfaceClient.openProject(path, {
          activate: false,
        });
        const opened = await windowIpc.create({
          workspacePath,
          simpleProjectPath: next.path,
        });
        if (!opened.success)
          throw new Error(
            opened.error || "Could not open the interface window.",
          );
        await loadProjects();
      } catch (error) {
        setProjectError(
          error instanceof Error
            ? error.message
            : "Could not open the interface.",
        );
      } finally {
        setProjectPending(false);
      }
    },
    [loadProjects, projectPending, readOnly, workspacePath],
  );

  const agent = useMemo(
    () => ({
      id: SIMPLE_PRIMARY_AGENT_ID,
      createdAt: 0,
      agent: {
        runtime: { modelConfig, workspacePath },
        session: { callerToken, codexThreadId: threadId ?? undefined },
      },
    }),
    [callerToken, modelConfig, threadId, workspacePath],
  );

  const handleThreadAssigned = useCallback(
    (_agentId: string, assignedThreadId: string) => {
      void Promise.resolve()
        .then(() => onBindThread(assignedThreadId))
        .then(() =>
          simplePrimaryThread.bindChannel({ threadId: assignedThreadId }),
        )
        .then(() => {
          setThreadId(assignedThreadId);
          setPersistenceError(false);
        })
        .catch((error) => {
          console.error(
            "[SimpleShell] Could not persist primary conversation",
            error,
          );
          setPersistenceError(true);
          setSurfaceMode("conversation");
        });
    },
    [onBindThread],
  );

  useEffect(() => {
    if (!threadId) return;
    void simplePrimaryThread.bindChannel({ threadId });
  }, [threadId]);

  const openSettings = useCallback(() => {
    setSettingsView("main");
    setSurfaceMode("settings");
    onOpenSettings();
  }, [onOpenSettings]);

  const collapseSurface = useCallback(() => {
    if (surfaceMode === "settings" && settingsView === "models") {
      setSettingsView("main");
      return;
    }
    if (surfaceMode === "settings") onCloseSettings();
    setSurfaceMode("compact");
  }, [onCloseSettings, settingsView, surfaceMode]);

  useEffect(
    () =>
      quickActions.onSimpleProjectAction?.(
        (event: { action: "new" | "open" | "recent"; path?: string }) => {
          if (event.action === "new" || event.action === "open") {
            void chooseProjectFolder(event.action);
            return;
          }
          if (event.action === "recent" && event.path) {
            void reopenProject(event.path);
          }
        },
      ),
    [chooseProjectFolder, reopenProject],
  );

  useEffect(() => {
    const closeDrawer = () => collapseSurface();
    window.addEventListener("simple-interface:interaction", closeDrawer);
    return () =>
      window.removeEventListener("simple-interface:interaction", closeDrawer);
  }, [collapseSurface]);

  const refreshProfiles = loadProfiles;

  const isConversationOpen = surfaceMode === "conversation";
  const isPresentationOpen = surfaceMode === "presentation";
  const isSettingsOpen = surfaceMode === "settings";
  const isCompact = surfaceMode === "compact";
  const visibleDrawerMode = isCompact ? lastExpandedSurfaceMode : surfaceMode;
  const drawerHeight =
    visibleDrawerMode === "conversation"
      ? "min(72vh, 680px)"
      : visibleDrawerMode === "settings"
        ? "min(68vh, 640px)"
        : "min(46vh, 440px)";
  const displayedActivitySummary = /^(new agent|agent)$/i.test(
    activitySummary.trim(),
  )
    ? isStreaming
      ? "Interpreter is working…"
      : "Ready"
    : activitySummary;

  useEffect(() => {
    if (surfaceMode !== "compact") setLastExpandedSurfaceMode(surfaceMode);
  }, [surfaceMode]);

  const startSurfaceDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (
        target.closest(
          'button, a, input, textarea, select, [contenteditable="true"]',
        )
      )
        return;
      if (!isCompact && !target.closest('[data-pill-drag-handle="true"]'))
        return;
      dragControls.start(event);
    },
    [dragControls, isCompact],
  );

  const snapSurface = useCallback(
    (element: HTMLElement) => {
      const bounds = dragBoundsRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const rect = element.getBoundingClientRect();
      const margin = 20;
      const xTargets = [
        bounds.left + margin,
        bounds.left + (bounds.width - rect.width) / 2,
        bounds.right - margin - rect.width,
      ];
      const yTargets = [
        bounds.top + margin,
        bounds.top + (bounds.height - rect.height) / 2,
        bounds.bottom - margin - rect.height,
      ];
      const candidates = xTargets
        .flatMap((left, xIndex) =>
          yTargets.map((top, yIndex) => ({ left, top, xIndex, yIndex })),
        )
        .filter(({ xIndex, yIndex }) => !(xIndex === 1 && yIndex === 1));
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const target = candidates.reduce(
        (best, candidate) => {
          const distance = Math.hypot(
            centerX - (candidate.left + rect.width / 2),
            centerY - (candidate.top + rect.height / 2),
          );
          return !best || distance < best.distance
            ? { ...candidate, distance }
            : best;
        },
        null as null | {
          left: number;
          top: number;
          xIndex: number;
          yIndex: number;
          distance: number;
        },
      );
      if (!target) return;
      void animate(dragX, dragX.get() + target.left - rect.left, {
        type: "spring",
        stiffness: 520,
        damping: 42,
        mass: 0.7,
      });
      void animate(dragY, dragY.get() + target.top - rect.top, {
        type: "spring",
        stiffness: 520,
        damping: 42,
        mass: 0.7,
      });
    },
    [dragX, dragY],
  );

  const selectProfile = useCallback(
    async (profile: Profile) => {
      if (modelPending || profile.id === selectedProfileId) return;
      setModelPending(true);
      setModelError(null);
      try {
        await setDefaultProfile(profile.id);
        setSelectedProfileId(profile.id);
        setModelConfig(
          profileToModelConfig(profile, {
            reasoningEffort: profile.reasoningEffort,
          }),
        );
        setModelStatus("ready");
      } catch (error) {
        setModelError(
          error instanceof Error
            ? error.message
            : "Could not change the model.",
        );
      } finally {
        setModelPending(false);
      }
    },
    [modelPending, selectedProfileId],
  );

  const composer = (expanded: boolean) =>
    !readOnly && !persistenceError && modelStatus === "ready" ? (
      <ComposerArea
        ref={composerRef}
        isTerminal={false}
        agentId={SIMPLE_PRIMARY_AGENT_ID}
        modelConfig={modelConfig}
        workspacePath={workspacePath}
        isStreaming={isStreaming}
        messageCount={messageCount}
        showSuggestionChips={false}
        showQueuedMessages={expanded}
        noBorderPadding={true}
        compactLayout={true}
        composerPlaceholder="Ask Interpreter"
        initialDraft={initialDraft}
        onDraftChange={persistComposerDraft}
        conciseStreamingActions={true}
        voiceButtonOverride={
          <button
            type="button"
            aria-label={
              live.state === "active" || live.state === "connecting"
                ? "Stop GPT Live"
                : live.state === "error"
                  ? "Retry GPT Live"
                  : "Start GPT Live"
            }
            aria-pressed={live.state === "active"}
            title={live.error ?? undefined}
            onClick={() =>
              live.state === "active" || live.state === "connecting"
                ? live.stop()
                : void live.start()
            }
            className="simple-live-button flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-[scale,filter] duration-150 hover:brightness-110 active:scale-[0.95]"
          >
            {live.state === "connecting" ? (
              <Loader2 className="size-[18px] animate-spin" />
            ) : live.state === "active" ? (
              <X className="size-[18px]" />
            ) : live.state === "error" ? (
              <CircleAlert className="size-[18px]" />
            ) : (
              <AudioLines className="size-[18px]" />
            )}
          </button>
        }
        settingsContent={<></>}
        onAgentSend={(text, options) => {
          window.dispatchEvent(
            new CustomEvent("agent-runtime:send", {
              detail: {
                tabId: SIMPLE_PRIMARY_AGENT_ID,
                text,
                workspacePath,
                attachments: options?.attachments,
                messageSource: options?.messageSource,
              },
            }),
          );
        }}
      />
    ) : !readOnly && !persistenceError ? (
      <div className="flex min-h-16 items-center justify-between gap-3 px-5 text-ui-sm">
        <span
          className={
            modelStatus === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          }
        >
          {modelStatus === "loading" && "Loading your models…"}
          {modelStatus === "missing" && "Choose a model before starting."}
          {modelStatus === "error" && "Your models could not be loaded."}
        </span>
        {modelStatus !== "loading" && (
          <button
            type="button"
            onClick={openSettings}
            className="shrink-0 rounded-full bg-foreground px-3 py-1.5 font-medium text-background"
          >
            Open settings
          </button>
        )}
      </div>
    ) : null;

  return (
    <div
      ref={dragBoundsRef}
      className="relative flex h-screen w-full flex-col overflow-hidden bg-background text-foreground"
      data-simple-shell="true"
      data-primary-thread-error={persistenceError ? "true" : undefined}
    >
      <main
        aria-label="Interface"
        className="absolute inset-0 overflow-y-auto"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) collapseSurface();
        }}
      >
        <div className="min-h-full" onPointerDown={collapseSurface}>
          {canvas}
        </div>
      </main>

      {ownsComposer ? (
        <div className="contents">
          <AgentMetadataProvider agent={agent}>
            <AgentErrorProvider>
              <motion.section
                aria-label="Primary conversation"
                data-simple-conversation="true"
                data-workstation-host={remoteWorkstation ? "remote" : "local"}
                data-surface-mode={surfaceMode}
                data-live-state={live.state}
                drag
                dragListener={false}
                dragControls={dragControls}
                dragConstraints={dragBoundsRef}
                dragElastic={0.04}
                dragMomentum={false}
                style={{
                  x: dragX,
                  y: dragY,
                  ["--simple-live-position" as string]: `${20 + live.level * 25}%`,
                  ["--simple-surface-fill" as string]:
                    "color-mix(in srgb, var(--oa-composer-surface, var(--background)) 82%, transparent)",
                }}
                onDragEnd={(event) =>
                  snapSurface(event.currentTarget as HTMLElement)
                }
                whileDrag={{ scale: 0.99 }}
                onPointerDown={startSurfaceDrag}
                transition={{ scale: { duration: 0.12 } }}
                className="absolute bottom-[18px] left-1/2 z-30 flex w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 flex-col overflow-visible"
              >
                <style>{`
              [data-simple-conversation] .oa-composer-surface {
                background: transparent !important;
                border: 0 !important;
                border-radius: 0 !important;
                box-shadow: none !important;
              }
              [data-simple-conversation] .oa-composer-surface {
                height: auto !important;
              }
              [data-simple-conversation] .oa-main-composer-preview {
                background: var(--oa-composer-surface, var(--background)) !important;
              }
              .simple-activity-tab {
                background: var(--simple-surface-fill);
                backdrop-filter: blur(28px) saturate(1.18);
                -webkit-backdrop-filter: blur(28px) saturate(1.18);
                border-radius: 14px 14px 0 0;
                border: 1px solid color-mix(in srgb, var(--foreground) 9%, transparent);
                border-bottom: 0;
                box-shadow: inset 0 1px color-mix(in srgb, var(--foreground) 3%, transparent);
              }
              .simple-drawer {
                background: var(--simple-surface-fill);
                backdrop-filter: blur(28px) saturate(1.18);
                -webkit-backdrop-filter: blur(28px) saturate(1.18);
              }
              [data-simple-conversation][data-workstation-host="remote"] .simple-activity-tab {
                border-color: color-mix(in srgb, #38bdf8 28%, transparent);
                box-shadow:
                  inset 0 1px color-mix(in srgb, #e0f2fe 8%, transparent),
                  0 -8px 28px color-mix(in srgb, #0ea5e9 8%, transparent);
              }
              [data-simple-conversation][data-workstation-host="remote"] .simple-composer-capsule {
                box-shadow:
                  0 0 0 1px color-mix(in srgb, #38bdf8 25%, transparent),
                  0 14px 38px rgba(0,0,0,.18) !important;
              }
              @keyframes simple-live-grain {
                0%, 100% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
              }
              [data-simple-conversation][data-live-state="active"] .simple-composer-capsule {
                background:
                  radial-gradient(circle at var(--simple-live-position) 35%, color-mix(in srgb, #7c5cff 34%, transparent), transparent 36%),
                  radial-gradient(circle at 78% 70%, color-mix(in srgb, #2f8cff 26%, transparent), transparent 40%),
                  color-mix(in srgb, var(--oa-composer-surface, var(--background)) 70%, transparent);
                background-size: 125% 125%;
                animation: simple-live-grain 2.8s ease-in-out infinite;
              }
              [data-simple-conversation][data-live-state="active"] .oa-main-composer-preview {
                background: transparent !important;
              }
              [data-simple-conversation] .oa-composer-body {
                display: block !important;
                min-height: 46px;
                height: auto;
                position: relative;
              }
              [data-simple-conversation] .oa-composer-body > div:first-child {
                width: 100%;
                min-width: 0;
                min-height: 46px;
                display: flex;
                align-items: center;
                padding: .6875rem 4rem .6875rem 2.75rem !important;
                box-sizing: border-box;
              }
              [data-simple-conversation] .oa-composer-body > div:first-child > div,
              [data-simple-conversation] .oa-composer-body > div:first-child > div > div {
                width: 100%;
                min-width: 0;
                flex: 1 1 auto;
              }
              [data-simple-conversation] .oa-composer-body > div:first-child > div > div {
                display: flex;
                align-items: center;
              }
              [data-simple-conversation][data-surface-mode="compact"][data-live-state="connecting"] .oa-composer-body > div:first-child,
              [data-simple-conversation][data-surface-mode="compact"][data-live-state="active"] .oa-composer-body > div:first-child,
              [data-simple-conversation][data-surface-mode="compact"][data-live-state="error"] .oa-composer-body > div:first-child {
                padding-right: 16.5rem !important;
              }
              [data-simple-conversation] .oa-composer-body > div:first-child > div > div {
                min-height: 1.5rem !important;
                max-height: 7.5rem;
              }
              [data-simple-conversation] .oa-composer-body .tiptap-editor {
                height: auto !important;
                min-height: 1.5rem;
                max-height: 7.5rem;
              }
              [data-simple-conversation] .oa-composer-body .ProseMirror {
                height: auto !important;
                min-height: 1.5rem;
                line-height: 1.5rem !important;
                padding-block: 0 !important;
              }
              [data-simple-conversation] .main-composer-content .ProseMirror.main-composer-editor p:first-child {
                flex: none !important;
                min-height: 1.5rem !important;
              }
              [data-simple-conversation] .oa-main-composer-placeholder {
                top: 50% !important;
                transform: translateY(-50%);
                line-height: 1.5rem !important;
                max-width: none !important;
                white-space: nowrap !important;
              }
              [data-simple-conversation] .oa-composer-body > div:nth-child(2) {
                position: absolute;
                inset: 0;
                pointer-events: none;
              }
              [data-simple-conversation] .oa-composer-body > div:nth-child(2) > div {
                min-height: 46px !important;
                height: 100%;
                padding: 0 !important;
                pointer-events: none;
              }
              [data-simple-conversation] .oa-composer-body > div:nth-child(2) > div > div:first-child {
                position: absolute;
                left: .5rem;
                top: 50%;
                transform: translateY(-50%);
                margin: 0 !important;
                pointer-events: auto;
              }
              [data-simple-conversation] .oa-composer-body > div:nth-child(2) > div > div:last-child {
                position: absolute;
                right: .5rem;
                top: 50%;
                transform: translateY(-50%);
                pointer-events: auto;
              }
            `}</style>

                <motion.div
                  data-simple-drawer="true"
                  aria-hidden={isCompact}
                  {...(isCompact ? { inert: true } : {})}
                  initial={false}
                  animate={{
                    opacity: isCompact ? 0 : 1,
                    y: isCompact ? 4 : 0,
                    clipPath: isCompact
                      ? "inset(100% 0 0 0 round 20px 20px 0 0)"
                      : "inset(0% 0 0 0 round 20px 20px 0 0)",
                  }}
                  transition={{
                    duration: isCompact ? 0.18 : 0.26,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  className={`simple-drawer absolute bottom-[calc(100%-1px)] left-5 right-5 z-0 flex flex-col overflow-hidden rounded-t-[20px] ${isCompact ? "pointer-events-none" : "pointer-events-auto"}`}
                  style={{
                    height: drawerHeight,
                    transformOrigin: "bottom center",
                    boxShadow:
                      "0 0 0 1px color-mix(in srgb, var(--foreground) 9%, transparent), 0 18px 48px rgba(0,0,0,.18)",
                  }}
                >
                  {surfaceMode !== "compact" && (
                    <motion.header
                      layout="position"
                      data-pill-drag-handle="true"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.14,
                        delay: 0.06,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                      className="flex h-12 shrink-0 cursor-grab items-center justify-between px-3 text-ui-sm active:cursor-grabbing"
                    >
                      <button
                        type="button"
                        aria-label="Back to interface"
                        onClick={collapseSurface}
                        className="flex min-h-10 items-center gap-2 rounded-full px-2.5 text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-foreground/5 hover:text-foreground active:scale-[0.96]"
                      >
                        <ArrowLeft className="size-4" />
                        <span>Back</span>
                      </button>
                      <span className="pr-3 font-medium text-foreground">
                        {isSettingsOpen
                          ? settingsView === "models"
                            ? "Models"
                            : "Settings"
                          : isPresentationOpen
                            ? (presentation?.title ?? "Update")
                            : "Conversation"}
                      </span>
                    </motion.header>
                  )}

                  {isPresentationOpen && presentation && (
                    <motion.div
                      layout="position"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.14,
                        delay: 0.04,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                      className="min-h-0 flex-1 overflow-y-auto border-y border-foreground/[0.06] p-4"
                    >
                      <div className="mx-auto flex h-full max-w-[720px] flex-col justify-center overflow-hidden rounded-2xl bg-foreground/[0.045]">
                        {presentationImageUrl && (
                          <img
                            src={presentationImageUrl}
                            alt=""
                            className="min-h-0 w-full flex-1 object-cover"
                          />
                        )}
                        {presentation.text && (
                          <p className="whitespace-pre-wrap px-5 py-4 text-[15px] leading-6 text-foreground">
                            {presentation.text}
                          </p>
                        )}
                        {!presentation.asset && !presentation.text && (
                          <p className="px-5 py-4 text-ui-sm text-muted-foreground">
                            {presentation.title}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {modelStatus === "ready" && (
                    <motion.div
                      layout="position"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.14,
                        delay: 0.07,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                      aria-hidden={!isConversationOpen}
                      {...(!isConversationOpen ? { inert: true } : {})}
                      className={
                        isConversationOpen
                          ? "flex min-h-0 flex-1 flex-col"
                          : "pointer-events-none absolute size-px overflow-hidden opacity-0"
                      }
                    >
                      <div
                        className={
                          isConversationOpen
                            ? "min-h-0 flex-1 overflow-hidden border-y border-foreground/[0.06]"
                            : "size-px overflow-hidden"
                        }
                      >
                        <AgentThread
                          key={`${selectedProfileId ?? "none"}:${threadId ?? "new"}`}
                          agentId={SIMPLE_PRIMARY_AGENT_ID}
                          codexThreadId={threadId ?? undefined}
                          callerToken={callerToken}
                          workspacePath={workspacePath}
                          modelConfig={modelConfig}
                          isVisible={isConversationOpen}
                          isEditorPane={false}
                          readOnly={readOnly}
                          allowConversationRestart={false}
                          onModelConfigUpdate={(_id, next) =>
                            setModelConfig(next)
                          }
                          onCodexThreadIdAssigned={handleThreadAssigned}
                          onLabelUpdate={(_id, label, running) => {
                            setActivitySummary(label);
                            setIsStreaming(running);
                          }}
                          onMessageCountChange={(_id, count) =>
                            setMessageCount(count)
                          }
                          onLatestAssistantMessage={(text) => {
                            live.sendResult(text);
                            if (threadId) {
                              void simplePrimaryThread.forwardChannelReply({
                                threadId,
                                text,
                              });
                            }
                          }}
                        />
                      </div>
                    </motion.div>
                  )}

                  {isSettingsOpen && settingsView === "main" && (
                    <motion.div
                      layout="position"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.14,
                        delay: 0.07,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                      className="min-h-0 flex-1 overflow-y-auto border-t border-foreground/[0.06] px-6 py-5"
                      aria-label="Settings"
                    >
                      <section
                        className="mb-7"
                        aria-labelledby="simple-interface-heading"
                      >
                        <div className="mb-3 flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <h2
                              id="simple-interface-heading"
                              className="text-ui-sm font-medium text-foreground"
                            >
                              Interface
                            </h2>
                            <p
                              className="mt-1 truncate text-ui-sm text-muted-foreground"
                              title={project?.path}
                            >
                              {project?.metadata.name ?? "Loading…"} ·{" "}
                              {project?.path ?? ""}
                            </p>
                          </div>
                          {project?.legacy && (
                            <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-1 text-[11px] text-muted-foreground">
                              Legacy prototype
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={projectPending || readOnly}
                            onClick={() => void chooseProjectFolder("new")}
                            className="rounded-full bg-foreground px-3 py-1.5 text-ui-sm font-medium text-background disabled:opacity-50"
                          >
                            New interface
                          </button>
                          <button
                            type="button"
                            disabled={projectPending || readOnly}
                            onClick={() => void chooseProjectFolder("open")}
                            className="rounded-full px-3 py-1.5 text-ui-sm font-medium hover:bg-foreground/[0.06] disabled:opacity-50"
                            style={{
                              border:
                                "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)",
                            }}
                          >
                            Open folder
                          </button>
                        </div>
                        {recentProjects.filter(
                          (item) => item.path !== project?.path,
                        ).length > 0 && (
                          <div
                            className="mt-3 flex flex-wrap gap-1.5"
                            aria-label="Recent interfaces"
                          >
                            {recentProjects
                              .filter((item) => item.path !== project?.path)
                              .slice(0, 5)
                              .map((item) => (
                                <button
                                  key={item.metadata.id}
                                  type="button"
                                  disabled={projectPending || readOnly}
                                  onClick={() => void reopenProject(item.path)}
                                  title={item.path}
                                  className="max-w-48 truncate rounded-full bg-foreground/[0.05] px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  {item.metadata.name}
                                </button>
                              ))}
                          </div>
                        )}
                        {projectError && (
                          <p
                            role="alert"
                            className="mt-2 text-ui-sm text-destructive"
                          >
                            {projectError}
                          </p>
                        )}
                      </section>
                      <section
                        className="mb-7"
                        aria-labelledby="simple-model-heading"
                      >
                        <div className="mb-3">
                          <h2
                            id="simple-model-heading"
                            className="text-ui-sm font-medium text-foreground"
                          >
                            Model
                          </h2>
                          <p className="mt-1 text-ui-sm text-muted-foreground">
                            Choose the model used by your Simple conversation.
                          </p>
                        </div>
                        <div
                          className="grid gap-2 sm:grid-cols-2"
                          role="radiogroup"
                          aria-label="Model"
                        >
                          {profiles.map((profile) => {
                            const selected = profile.id === selectedProfileId;
                            return (
                              <button
                                key={profile.id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                disabled={modelPending}
                                onClick={() => void selectProfile(profile)}
                                className={`flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-[background-color,border-color,scale] duration-150 active:scale-[0.99] ${selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]"}`}
                                style={{
                                  border:
                                    "1px solid color-mix(in srgb, var(--foreground) 9%, transparent)",
                                }}
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-ui-sm font-medium text-foreground">
                                    {profile.name}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {profile.modelId}
                                  </span>
                                </span>
                                {selected && (
                                  <Check className="size-4 shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                        {profiles.length === 0 && (
                          <p className="text-ui-sm text-muted-foreground">
                            No configured models are available.
                          </p>
                        )}
                        {modelError && (
                          <p
                            role="alert"
                            className="mt-2 text-ui-sm text-destructive"
                          >
                            {modelError}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => setSettingsView("models")}
                          className="mt-3 rounded-full px-3 py-1.5 text-ui-sm font-medium text-foreground transition-[background-color,scale] duration-150 hover:bg-foreground/[0.06] active:scale-[0.98]"
                          style={{
                            border:
                              "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)",
                          }}
                        >
                          Add or manage models
                        </button>
                      </section>
                      <ExperienceSectionContent />
                      <div className="mt-7 border-t border-foreground/[0.08] pt-5">
                        <SimpleConnectionsSettings />
                        {live.error && (
                          <p
                            role="alert"
                            className="mt-2 text-ui-sm text-destructive"
                          >
                            {live.error}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {isSettingsOpen && settingsView === "models" && (
                    <motion.div
                      layout="position"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.14,
                        delay: 0.07,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                      className="min-h-0 flex-1 overflow-y-auto border-t border-foreground/[0.06] px-6 py-5"
                      aria-label="Models"
                    >
                      <ProfilesSectionContent
                        selectedProfileId={selectedProfileId}
                        onProfileUpdate={(profile) => {
                          void refreshProfiles(profile);
                        }}
                      />
                    </motion.div>
                  )}
                </motion.div>

                <motion.div
                  data-simple-activity-tab="true"
                  data-pill-drag-handle="true"
                  className="simple-activity-tab relative z-10 -mb-px ml-5 flex h-8 w-[calc(100%-2.5rem)] items-center gap-1 px-2.5"
                >
                  <button
                    type="button"
                    aria-label={
                      isConversationOpen
                        ? "Collapse conversation"
                        : "Show conversation"
                    }
                    aria-expanded={isConversationOpen}
                    onClick={() =>
                      isConversationOpen
                        ? collapseSurface()
                        : setSurfaceMode("conversation")
                    }
                    className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-full px-1.5 text-left text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
                  >
                    <ChevronRight
                      className={`size-3.5 shrink-0 transition-transform duration-200 ${isConversationOpen ? "-rotate-90" : "rotate-0"}`}
                    />
                    <span className="truncate">
                      {isStreaming
                        ? displayedActivitySummary
                        : messageCount
                          ? displayedActivitySummary
                          : "Ready"}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={
                      isSettingsOpen ? "Close settings" : "Open Settings"
                    }
                    aria-expanded={isSettingsOpen}
                    onClick={() =>
                      isSettingsOpen ? collapseSurface() : openSettings()
                    }
                    className="mr-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.94]"
                  >
                    <Settings2 className="size-3" />
                  </button>
                </motion.div>

                <motion.div
                  data-simple-composer-capsule="true"
                  className="simple-composer-capsule relative z-10 min-w-0 shrink-0 overflow-hidden rounded-full"
                  style={{
                    background: "var(--simple-surface-fill)",
                    backdropFilter: "blur(28px) saturate(1.18)",
                    WebkitBackdropFilter: "blur(28px) saturate(1.18)",
                    boxShadow:
                      "0 0 0 1px color-mix(in srgb, var(--foreground) 9%, transparent), 0 14px 38px rgba(0,0,0,.18)",
                  }}
                >
                  {persistenceError && (
                    <div
                      role="alert"
                      className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-ui-sm text-destructive"
                    >
                      The primary conversation could not be saved. Reload
                      Interpreter to recover before sending again.
                      <button
                        type="button"
                        className="ml-2 underline"
                        onClick={() => window.location.reload()}
                      >
                        Reload
                      </button>
                    </div>
                  )}
                  {overlayError && (
                    <div
                      role="alert"
                      className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-ui-sm text-destructive"
                    >
                      {overlayError}
                    </div>
                  )}
                  {composer(isConversationOpen)}
                </motion.div>
              </motion.section>
            </AgentErrorProvider>
          </AgentMetadataProvider>
        </div>
      ) : null}
    </div>
  );
}
