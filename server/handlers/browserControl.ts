import type { BrowserAccessPolicy } from '../../shared/browserAccessPolicy';
import { broadcastEvent } from './broadcast';
import * as configStore from '../configStore';
import {
  activateBrowserControlTab,
  ensureBrowserExtensionRelayRunning,
  formatOptionalBrowserExtensionRelayStartupFailureLog,
  getBrowserControlStatus as getBrowserControlRelayStatus,
} from '../utils/browserExtensionRelay';

const RELAY_HTTP_ENDPOINT = 'http://127.0.0.1:19988';

export async function getBrowserControlStatus() {
  await ensureBrowserExtensionRelayRunning().catch((error) => {
    console.warn(formatOptionalBrowserExtensionRelayStartupFailureLog(error));
  });
  return getBrowserControlRelayStatus();
}

export async function getBrowserControlPolicy() {
  return {
    policy: await configStore.getBrowserAccessPolicy(),
  };
}

export async function setBrowserControlPolicy(policy: BrowserAccessPolicy) {
  const nextPolicy = await configStore.setBrowserAccessPolicy(policy);
  broadcastEvent('browserControl:changed', {
    reason: 'policy',
    policy: nextPolicy,
  });
  return {
    success: true,
    policy: nextPolicy,
  };
}

export async function arrangeBrowserControlWindow(request: {
  extensionId: string;
  targetId: string;
  bounds: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}) {
  await ensureBrowserExtensionRelayRunning().catch((error) => {
    console.warn(formatOptionalBrowserExtensionRelayStartupFailureLog(error));
  });

  const response = await fetch(`${RELAY_HTTP_ENDPOINT}/extension/arrange-window`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(6_000),
  });

  const payload = await response.json().catch(() => null) as {
    success?: unknown;
    error?: unknown;
  } | null;

  if (!response.ok || payload?.success !== true) {
    return {
      success: false,
      error: typeof payload?.error === 'string'
        ? payload.error
        : `Browser arrangement failed with HTTP ${response.status}`,
    };
  }

  return { success: true };
}

export async function activateBrowserControlTabForReview(request: { tabRef: string }) {
  const tabRef = request.tabRef.trim();
  if (!tabRef) {
    return { success: false, error: 'tabRef must be a non-empty string.' };
  }

  await ensureBrowserExtensionRelayRunning().catch((error) => {
    console.warn(formatOptionalBrowserExtensionRelayStartupFailureLog(error));
  });

  try {
    await activateBrowserControlTab({ tabRef });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
