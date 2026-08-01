import type { LayoutState } from '../shared/types/layout';

const WINDOW_SESSION_KEY_ARG_PREFIX = '--interpreter-window-session=';
const WINDOW_BOOTSTRAP_LAYOUT_ARG_PREFIX = '--interpreter-window-bootstrap-layout=';

function getArgValue(argv: readonly string[], prefix: string): string | null {
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

export function buildWindowSessionKeyArg(sessionKey: string): string {
  return `${WINDOW_SESSION_KEY_ARG_PREFIX}${sessionKey}`;
}

export function parseWindowSessionKeyArg(argv: readonly string[]): string | null {
  return getArgValue(argv, WINDOW_SESSION_KEY_ARG_PREFIX);
}

export function buildWindowBootstrapLayoutArg(layoutState: LayoutState | null): string | null {
  if (!layoutState) {
    return null;
  }

  const encodedLayout = Buffer.from(JSON.stringify(layoutState), 'utf8').toString('base64url');
  return `${WINDOW_BOOTSTRAP_LAYOUT_ARG_PREFIX}${encodedLayout}`;
}

export function parseWindowBootstrapLayoutArg(argv: readonly string[]): LayoutState | null {
  const encodedLayout = getArgValue(argv, WINDOW_BOOTSTRAP_LAYOUT_ARG_PREFIX);
  if (!encodedLayout) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encodedLayout, 'base64url').toString('utf8')) as LayoutState;
  } catch (error) {
    console.error('[WindowSessionArgs] Failed to parse bootstrap layout:', error);
    return null;
  }
}
