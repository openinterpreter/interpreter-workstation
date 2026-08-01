import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/index.css';
import { getRendererDomSnapshot } from './overlay-debug-snapshot.js';
import { Overlay } from './overlay.js';

function getRendererDebugSnapshot(): unknown {
  return (window as Window & { __INTERPRETER_OVERLAY_DEBUG__?: unknown }).__INTERPRETER_OVERLAY_DEBUG__ ?? null;
}

function logRendererError(label: string, payload: Record<string, unknown>): void {
  const snapshot = {
    ...payload,
    overlayState: getRendererDebugSnapshot(),
    domSnapshot: getRendererDomSnapshot(document, window),
  };
  try {
    console.error(label, JSON.stringify(snapshot, null, 2));
  } catch {
    console.error(label, snapshot);
  }
}

interface RendererErrorBoundaryProps {
  children: React.ReactNode;
}

interface RendererErrorBoundaryState {
  hasError: boolean;
}

class RendererErrorBoundary extends React.Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logRendererError('[InterpreterOverlay][RendererBoundary] Caught renderer error', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return null;
    }

    return this.props.children;
  }
}

window.addEventListener('error', (event) => {
  logRendererError('[InterpreterOverlay][RendererGlobalError]', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack : null,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error
    ? {
        message: event.reason.message,
        stack: event.reason.stack,
      }
    : event.reason;
  logRendererError('[InterpreterOverlay][RendererUnhandledRejection]', {
    reason,
  });
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

const root = createRoot(rootElement);
root.render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <Overlay />
    </RendererErrorBoundary>
  </React.StrictMode>,
);
