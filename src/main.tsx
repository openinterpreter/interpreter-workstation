import { createRoot } from "react-dom/client";
import App from "./App";
import { trackAppError } from "./utils/telemetry";
import "./index.css";

type SerializedRendererLogValue =
  | null
  | boolean
  | number
  | string
  | SerializedRendererLogValue[]
  | { [key: string]: SerializedRendererLogValue };

function serializeRendererLogArg(
  value: unknown,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet(),
): SerializedRendererLogValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (depth >= 4) {
    return `[MaxDepth:${(value as { constructor?: { name?: string } }).constructor?.name ?? "Object"}]`;
  }
  if (value instanceof Error) {
    const errorRecord: Record<string, SerializedRendererLogValue> = {
      __interpreterLogType: "Error",
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
    if ("cause" in value && value.cause !== undefined) {
      errorRecord.cause = serializeRendererLogArg(value.cause, depth + 1, seen);
    }
    return errorRecord;
  }
  if (value instanceof Event) {
    const eventRecord: Record<string, SerializedRendererLogValue> = {
      __interpreterLogType: "Event",
      constructorName: value.constructor?.name ?? "Event",
      type: value.type,
    };
    if (typeof ErrorEvent !== "undefined" && value instanceof ErrorEvent) {
      eventRecord.message = value.message || null;
      eventRecord.filename = value.filename || null;
      eventRecord.lineno = value.lineno || null;
      eventRecord.colno = value.colno || null;
      eventRecord.error = serializeRendererLogArg(value.error, depth + 1, seen);
    }
    if (typeof PromiseRejectionEvent !== "undefined" && value instanceof PromiseRejectionEvent) {
      eventRecord.reason = serializeRendererLogArg(value.reason, depth + 1, seen);
    }
    return eventRecord;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeRendererLogArg(item, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const objectRecord: Record<string, SerializedRendererLogValue> = {};
    const constructorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (constructorName && constructorName !== "Object") {
      objectRecord.__interpreterLogType = constructorName;
    }
    for (const [key, entry] of Object.entries(value)) {
      objectRecord[key] = serializeRendererLogArg(entry, depth + 1, seen);
    }
    if (Object.keys(objectRecord).length === 0 && constructorName) {
      objectRecord.__interpreterLogType = constructorName;
      objectRecord.value = String(value);
    }
    return objectRecord;
  }
  return String(value);
}

function forwardRendererLog(level: string, args: unknown[]): void {
  if (!rendererLog) {
    return;
  }
  try {
    rendererLog(
      level,
      ...args.map((arg) => serializeRendererLogArg(arg)),
    );
  } catch (error) {
    rendererLog(level, "[RendererLogForwardingFailed]", serializeRendererLogArg(error));
  }
}

const rendererLog = typeof (window.electron as { log?: unknown } | undefined)?.log === "function"
  ? window.electron.log.bind(window.electron)
  : null;

// Capture renderer console output and forward it to the session log.
if (rendererLog) {
  const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };

  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    forwardRendererLog("LOG", args);
  };
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    forwardRendererLog("ERROR", args);
  };
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    forwardRendererLog("WARN", args);
  };
  console.info = (...args: unknown[]) => {
    originalConsole.info(...args);
    forwardRendererLog("INFO", args);
  };
  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args);
    forwardRendererLog("DEBUG", args);
  };

  console.log("[RendererBootstrap] Console forwarding enabled");
}

window.addEventListener("error", (event) => {
  console.error("[RendererError] uncaught", {
    message: event.error?.message ?? event.message ?? "Unknown error",
    filename: event.filename || null,
    lineno: event.lineno || null,
    colno: event.colno || null,
    error: event.error,
  });
  trackAppError({
    type: "uncaught_error",
    message: event.error?.message ?? event.message ?? "Unknown error",
    source: "renderer",
  });
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[RendererError] unhandledrejection", {
    reason: event.reason,
  });
  const message = event.reason instanceof Error
    ? event.reason.message
    : String(event.reason ?? "Unknown rejection");
  trackAppError({
    type: "unhandled_rejection",
    message,
    source: "renderer",
  });
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  console.error("[RendererBootstrap] Missing root element", {
    readyState: document.readyState,
  });
  throw new Error('Renderer root element "#root" not found.');
}

console.log("[RendererBootstrap] Rendering App", {
  readyState: document.readyState,
});
createRoot(rootElement, {
  onUncaughtError(error, errorInfo) {
    console.error("[RendererError] react-uncaught", {
      error,
      componentStack: errorInfo.componentStack,
    });
  },
}).render(<App />);

const startupSplash = document.getElementById("startup-splash");
if (startupSplash) {
  requestAnimationFrame(() => {
    startupSplash.dataset.state = "dismissed";
    window.setTimeout(() => {
      startupSplash.remove();
    }, 520);
  });
}
