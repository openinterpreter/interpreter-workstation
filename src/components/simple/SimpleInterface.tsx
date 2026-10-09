import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { isWorkstationReadOnly } from "../../remote/workstationConnection";
import { getPathForFile, showItemInFolder, simpleInterfaceAgents } from "../../ipc";
import { EditorArea } from "../EditorArea";
import { Explorer } from "../Explorer";
import type {
  SimpleInterfaceAgentEvent,
  SimpleInterfaceAgentStartResponse,
} from "../../../electron/ipc/registry";
import {
  simpleInterfaceClient,
  type SimpleAppStatus,
} from "./simpleInterfaceClient";

type Props = {
  /** Messages from generated interface code enter the one durable conversation. */
  onMessage?: (message: string, source?: string) => Promise<void> | void;
};

type BridgeRequest = {
  protocol?: unknown;
  type?: unknown;
  id?: unknown;
  message?: unknown;
  value?: unknown;
  view?: unknown;
  path?: unknown;
  text?: unknown;
  files?: unknown;
  point?: unknown;
  key?: unknown;
  token?: unknown;
};

type HostView = {
  id: string;
  kind: "file" | "folder";
  requestedPath: string;
  path: string | null;
  rect: { x: number; y: number; width: number; height: number };
  error?: string;
};

const PROTOCOL = "interpreter-interface-v1";

function pathIsWithin(root: string, candidate: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function SimpleInterface({ onMessage }: Props) {
  const [status, setStatus] = useState<SimpleAppStatus | null>(null);
  const [runtimeUrl, setRuntimeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const revisionRef = useRef<string | null>(null);
  const runtimeUrlRef = useRef<string | null>(null);
  const uiSnapshotRequestsRef = useRef(new Map<string, (value: Record<string, unknown>) => void>());
  const inFlightRef = useRef(false);
  const [hostViews, setHostViews] = useState<Record<string, HostView>>({});
  const authorizedDropRootsRef = useRef<Set<string>>(new Set());
  const projectPathRef = useRef<string | null>(null);

  const postHostEvent = useCallback((name: string, detail: unknown) => {
    iframeRef.current?.contentWindow?.postMessage({ protocol: PROTOCOL, type: "host-event", name, detail }, "*");
  }, []);

  const rememberIframe = useCallback((node: HTMLIFrameElement | null) => {
    if (node) iframeRef.current = node;
  }, []);

  const captureUiState = useCallback(async (): Promise<void> => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame) return;
    const token = `snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const snapshot = await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = window.setTimeout(() => {
        uiSnapshotRequestsRef.current.delete(token);
        resolve(null);
      }, 500);
      uiSnapshotRequestsRef.current.set(token, (value) => {
        window.clearTimeout(timer);
        uiSnapshotRequestsRef.current.delete(token);
        resolve(value);
      });
      frame.postMessage({ protocol: PROTOCOL, type: "host-event", name: "capture-ui-state", detail: { token } }, "*");
    });
    if (snapshot) await simpleInterfaceClient.setAppUiState(snapshot);
  }, []);

  useEffect(() => {
    const refreshProjectPath = () => void simpleInterfaceClient.projects().then(({ active }) => {
      projectPathRef.current = active.path;
    }).catch(() => {
      projectPathRef.current = null;
    });
    refreshProjectPath();
    window.addEventListener("simple-project:changed", refreshProjectPath);
    return () => window.removeEventListener("simple-project:changed", refreshProjectPath);
  }, []);

  useEffect(() => {
    try {
      return simpleInterfaceAgents.onEvent(({ runId, event }: SimpleInterfaceAgentEvent) => {
        postHostEvent(`agent-run:${runId}`, event);
      });
    } catch {
      return undefined;
    }
  }, [postHostEvent]);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const next = await simpleInterfaceClient.refresh();
      const nextRuntimeUrl =
        next.ready && next.revision
          ? await simpleInterfaceClient.appUrl(next.revision)
          : null;
      if (revisionRef.current && next.revision && revisionRef.current !== next.revision) {
        await captureUiState();
      }
      revisionRef.current = next.revision || null;
      // Reset mounts before exposing the new iframe. A passive effect after
      // render can erase registrations sent by an iframe that loads promptly.
      if (runtimeUrlRef.current !== nextRuntimeUrl) {
        runtimeUrlRef.current = nextRuntimeUrl;
        setHostViews({});
      }
      setStatus((previous) =>
        previous?.revision === next.revision &&
        previous?.diagnostic === next.diagnostic &&
        previous?.sourceRevision === next.sourceRevision
          ? previous
          : next,
      );
      setRuntimeUrl(nextRuntimeUrl);
      setError(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Unable to compile the interface.",
      );
    } finally {
      inFlightRef.current = false;
    }
  }, [captureUiState]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 900);
    const onProjectChanged = () => {
      authorizedDropRootsRef.current.clear();
      revisionRef.current = null;
      runtimeUrlRef.current = null;
      setHostViews({});
      setStatus(null);
      setRuntimeUrl(null);
      void refresh();
    };
    window.addEventListener("simple-project:changed", onProjectChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("simple-project:changed", onProjectChanged);
    };
  }, [refresh]);

  useEffect(() => {
    const respond = (
      source: Window,
      id: string,
      ok: boolean,
      value?: unknown,
      responseError?: string,
    ) => {
      source.postMessage(
        {
          protocol: PROTOCOL,
          type: "response",
          id,
          ok,
          value,
          error: responseError,
        },
        "*",
      );
    };
    const onBridgeMessage = (event: MessageEvent<BridgeRequest>) => {
      const belongsToInterface = Array.from(rootRef.current?.querySelectorAll<HTMLIFrameElement>("iframe[data-simple-interface-frame]") ?? [])
        .some((frame) => frame.contentWindow === event.source);
      if (!belongsToInterface) return;
      const request = event.data;
      if (
        !request ||
        request.protocol !== PROTOCOL ||
        typeof request.type !== "string"
      )
        return;
      if (request.type === "ready") return;
      if (request.type === "interaction") {
        window.dispatchEvent(new CustomEvent("simple-interface:interaction"));
        return;
      }
      if (request.type === "ui-state-snapshot" && typeof request.token === "string") {
        if (request.value && typeof request.value === "object" && !Array.isArray(request.value)) {
          uiSnapshotRequestsRef.current.get(request.token)?.(request.value as Record<string, unknown>);
        }
        return;
      }
      if (request.type === "runtime-error") {
        const message = String(
          request.message ?? "Interface runtime error",
        ).slice(0, 4000);
        setError(message);
        void simpleInterfaceClient.runtimeError(message).catch(() => {});
        return;
      }
      if (request.type === "selection") {
        const text = typeof request.text === "string" ? request.text.trim().slice(0, 10_240) : "";
        window.dispatchEvent(new CustomEvent("selection:changed", {
          detail: text ? { type: "text", text, source: typeof request.path === "string" && request.path ? { type: "file", path: request.path } : { type: "unknown" } } : null,
        }));
        return;
      }
      if (request.type === "files-dropped") {
        const files = Array.isArray(request.files) ? request.files.filter((file): file is File => file instanceof File) : [];
        const descriptors = files.map((file) => ({ file, path: getPathForFile(file) })).filter((item): item is { file: File; path: string } => Boolean(item.path));
        descriptors.forEach(({ path }) => authorizedDropRootsRef.current.add(path));
        postHostEvent("files-dropped", {
          files: descriptors.map(({ file, path }) => ({ name: file.name, type: file.type, size: file.size, path })),
          point: request.point,
        });
        return;
      }
      if (request.type === "file-reveal" && typeof request.id === "string") {
        const requestedPath = typeof request.path === "string" ? request.path : "";
        const allowedDropPath = [...authorizedDropRootsRef.current].find((root) => pathIsWithin(root, requestedPath));
        const source = event.source as Window;
        if (!requestedPath) {
          respond(source, request.id, false, undefined, "A file path is required.");
          return;
        }
        void (allowedDropPath
          ? Promise.resolve({ path: requestedPath })
          : simpleInterfaceClient.resolvePath(requestedPath)
        ).then(async (resolved) => {
          await showItemInFolder(resolved.path);
          respond(source, request.id as string, true, { revealed: true });
        }).catch((failure) => respond(
          source,
          request.id as string,
          false,
          undefined,
          failure instanceof Error ? failure.message : "Could not reveal this file.",
        ));
        return;
      }
      if (request.type === "host-view-unregister" && typeof request.id === "string") {
        setHostViews((current) => {
          const next = { ...current }; delete next[request.id as string]; return next;
        });
        return;
      }
      if (request.type === "host-view-register") {
        const view = request.view as { id?: unknown; kind?: unknown; path?: unknown; rect?: Record<string, unknown> } | undefined;
        if (!view || typeof view.id !== "string" || (view.kind !== "file" && view.kind !== "folder") || typeof view.path !== "string") return;
        const numeric = (key: "x" | "y" | "width" | "height") => Number(view.rect?.[key]);
        const rect = { x: numeric("x"), y: numeric("y"), width: numeric("width"), height: numeric("height") };
        if (!Object.values(rect).every(Number.isFinite) || rect.width < 20 || rect.height < 20) return;
        const requestedPath = view.path;
        const allowedDropPath = [...authorizedDropRootsRef.current].find((root) => pathIsWithin(root, requestedPath));
        setHostViews((current) => ({ ...current, [view.id as string]: { id: view.id as string, kind: view.kind as "file" | "folder", requestedPath, path: allowedDropPath ? requestedPath : current[view.id as string]?.path ?? null, rect } }));
        if (!allowedDropPath) {
          void simpleInterfaceClient.resolvePath(requestedPath).then((resolved) => {
            setHostViews((current) => current[view.id as string]
              ? { ...current, [view.id as string]: { ...current[view.id as string], path: resolved.path, kind: resolved.directory ? "folder" : "file", error: undefined } }
              : current);
          }).catch((failure) => {
            setHostViews((current) => current[view.id as string]
              ? { ...current, [view.id as string]: { ...current[view.id as string], error: failure instanceof Error ? failure.message : "Could not open this path." } }
              : current);
          });
        }
        return;
      }
      if (typeof request.id !== "string") return;
      const requestId = request.id;
      const source = event.source as Window;
      if (request.type === "run-agent") {
        const value = request.value as { runId?: unknown; message?: unknown; system?: unknown; timeoutMs?: unknown } | undefined;
        if (isWorkstationReadOnly() || !value || typeof value.runId !== "string" || typeof value.message !== "string") {
          respond(source, requestId, false, undefined, "This interface cannot start that focused agent.");
          return;
        }
        void simpleInterfaceAgents.start({
          runId: value.runId.slice(0, 120),
          message: value.message.slice(0, 24_000),
          system: typeof value.system === "string" ? value.system.slice(0, 24_000) : undefined,
          timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : undefined,
        }).then((response: SimpleInterfaceAgentStartResponse) => {
          if (response.success) respond(source, requestId, true, response.result);
          else respond(source, requestId, false, undefined, response.error ?? "Focused agent failed.");
        }).catch((failure: unknown) => respond(source, requestId, false, undefined, failure instanceof Error ? failure.message : "Focused agent failed."));
        return;
      }
      if (request.type === "send-message") {
        const message =
          typeof request.message === "string" ? request.message.trim() : "";
        if (
          !message ||
          message.length > 6000 ||
          !onMessage ||
          isWorkstationReadOnly()
        ) {
          respond(
            source,
            requestId,
            false,
            undefined,
            "This interface cannot send that message.",
          );
          return;
        }
        const messageSource = projectPathRef.current
          ? `interface ${projectPathRef.current}`
          : "the active interface";
        void Promise.resolve(onMessage(message, messageSource))
          .then(() => respond(source, requestId, true, { delivered: true }))
          .catch((failure) =>
            respond(
              source,
              requestId,
              false,
              undefined,
              failure instanceof Error
                ? failure.message
                : "Message delivery failed.",
            ),
          );
        return;
      }
      if (request.type === "state-get") {
        void simpleInterfaceClient
          .appState()
          .then((value) => respond(source, requestId, true, value))
          .catch((failure) =>
            respond(
              source,
              requestId,
              false,
              undefined,
              failure instanceof Error ? failure.message : "State read failed.",
            ),
          );
        return;
      }
      if (request.type === "state-set") {
        if (
          !request.value ||
          typeof request.value !== "object" ||
          Array.isArray(request.value) ||
          isWorkstationReadOnly()
        ) {
          respond(
            source,
            requestId,
            false,
            undefined,
            "Interface state must be an object.",
          );
          return;
        }
        void simpleInterfaceClient
          .setAppState(request.value as Record<string, unknown>)
          .then((value) => respond(source, requestId, true, value))
          .catch((failure) =>
            respond(
              source,
              requestId,
              false,
              undefined,
              failure instanceof Error
                ? failure.message
                : "State write failed.",
            ),
          );
        return;
      }
      if (request.type === "state-update") {
        if (typeof request.key !== "string" || !request.key.trim() || isWorkstationReadOnly()) {
          respond(source, requestId, false, undefined, "Interface state key must be a non-empty string.");
          return;
        }
        void simpleInterfaceClient.updateAppState(request.key, request.value)
          .then((value) => respond(source, requestId, true, value))
          .catch((failure) => respond(source, requestId, false, undefined, failure instanceof Error ? failure.message : "State update failed."));
        return;
      }
      if (request.type === "ui-state-get") {
        void simpleInterfaceClient.appUiState()
          .then((value) => respond(source, requestId, true, value))
          .catch((failure) => respond(source, requestId, false, undefined, failure instanceof Error ? failure.message : "UI state read failed."));
        return;
      }
      if (request.type === "ui-state-set") {
        if (!request.value || typeof request.value !== "object" || Array.isArray(request.value) || isWorkstationReadOnly()) {
          respond(source, requestId, false, undefined, "Interface UI state must be an object.");
          return;
        }
        void simpleInterfaceClient.setAppUiState(request.value as Record<string, unknown>)
          .then((value) => respond(source, requestId, true, value))
          .catch((failure) => respond(source, requestId, false, undefined, failure instanceof Error ? failure.message : "UI state write failed."));
      }
    };
    window.addEventListener("message", onBridgeMessage);
    return () => window.removeEventListener("message", onBridgeMessage);
  }, [onMessage, postHostEvent]);

  return (
    <main
      ref={rootRef}
      aria-label="Interpreter interface"
      className="absolute inset-0 overflow-hidden bg-background text-foreground"
    >
      {status?.ready && status.revision && runtimeUrl ? (
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={status.revision}
            className="absolute inset-0"
            initial={{ opacity: 0, scale: 0.998, filter: "blur(3px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 1.002, filter: "blur(2px)" }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <iframe
              ref={rememberIframe}
              data-simple-interface-frame
              title="Interpreter interface"
              src={runtimeUrl}
              sandbox="allow-scripts"
              onFocus={() => window.dispatchEvent(new CustomEvent("simple-interface:interaction"))}
              className="absolute inset-0 size-full border-0 bg-transparent"
            />
          </motion.div>
        </AnimatePresence>
      ) : (
        <div className="grid size-full place-items-center px-6 pb-32 text-ui-sm text-muted-foreground">
          {status?.diagnostic
            ? "The interface needs a code fix. See interface/.runtime/diagnostics.json."
            : "Compiling your interface…"}
        </div>
      )}
      {Object.values(hostViews).map((view) => (
        <div
          key={view.id}
          data-simple-host-view={view.kind}
          className="absolute z-10 overflow-hidden rounded-[18px] border border-foreground/10 bg-background shadow-sm"
          style={{ left: view.rect.x, top: view.rect.y, width: view.rect.width, height: view.rect.height }}
          onPointerDown={() => window.dispatchEvent(new CustomEvent("simple-interface:interaction"))}
        >
          {view.path && view.kind === "file" ? (
            <EditorArea filePath={view.path} />
          ) : view.path && view.kind === "folder" ? (
            <Explorer
              rootPath={view.path}
              compactMode
              onFileOpen={(path) => postHostEvent(`file-open:${view.id}`, { path })}
            />
          ) : (
            <div className="grid size-full place-items-center px-4 text-center text-xs text-muted-foreground">
              {view.error ?? "Opening…"}
            </div>
          )}
        </div>
      ))}
      {(status?.diagnostic || error) && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-5 z-20 max-w-[min(760px,calc(100%-2rem))] -translate-x-1/2 rounded-full border border-foreground/10 bg-background/90 px-4 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur-xl"
        >
          The latest interface edit needs fixing. The last working version is
          still running.
        </div>
      )}
    </main>
  );
}
