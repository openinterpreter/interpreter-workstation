/**
 * Telemetry Service
 *
 * Sends anonymous usage analytics to the Open Interpreter backend.
 * Respects the user's telemetryEnabled setting - never sends if disabled.
 *
 * Telemetry failures are silently caught - they should never crash the app.
 */

import { createHash, randomUUID } from 'crypto';
import { getInterpreterTelemetryUrl } from '../shared/hostedApi';
import { distributionProductConfig } from '../shared/productConfig';
import * as configStore from './configStore';

const TELEMETRY_URL = getInterpreterTelemetryUrl();
const CLIENT_NAME = 'interpreter';

const SUPABASE_URL = distributionProductConfig.telemetry.eventsUrl;
const SUPABASE_ANON_KEY = distributionProductConfig.telemetry.eventsAnonKey;

// Session ID is generated once per app launch
let sessionId: string | null = null;

// Cache telemetry enabled state to avoid repeated config reads
let telemetryEnabledCache: boolean | null = null;
let hasWarnedAboutLegacyTelemetryFailure = false;
let hasWarnedAboutWorkstationEventsFailure = false;

const ADS_IMPORTABLE_EVENTS = new Set([
  'signed_in',
  'first_successful_interaction',
  'pdf_form_saved',
]);

type DecodedAuthClaims = {
  sub?: string;
  email?: string;
};

/**
 * Get or generate a persistent device ID for anonymous tracking
 */
async function getDeviceId(): Promise<string> {
  const config = await configStore.loadConfig();

  if (config.deviceId) {
    return config.deviceId;
  }

  // Generate new device ID and persist it
  const deviceId = randomUUID();
  config.deviceId = deviceId;
  await configStore.saveConfig(config);

  return deviceId;
}

/**
 * Get the session ID (generated once per app launch)
 */
function getSessionId(): string {
  if (!sessionId) {
    sessionId = randomUUID();
  }
  return sessionId;
}

/**
 * Check if telemetry is enabled
 */
async function isTelemetryEnabled(): Promise<boolean> {
  // Use cached value if available
  if (telemetryEnabledCache !== null) {
    return telemetryEnabledCache;
  }

  const enabled = await configStore.getTelemetryEnabled();
  // Default to false if not set
  telemetryEnabledCache = enabled ?? false;
  return telemetryEnabledCache;
}

/**
 * Clear the telemetry enabled cache (call when setting changes)
 */
export function clearTelemetryCache(): void {
  telemetryEnabledCache = null;
}

/**
 * Get app version from package.json
 */
function getAppVersion(): string {
  // In Electron, use runtime app version so telemetry matches About/version.
  if (process.versions.electron) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app.getVersion() || 'unknown';
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../package.json');
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export type TelemetryLevel = 'info' | 'warn' | 'error';

export interface TelemetryOptions {
  tag?: string;
  userId?: string; // Valid UUID from auth if user is authenticated
}

/**
 * Send telemetry event to the Open Interpreter backend
 *
 * @param level - Log level: 'info', 'warn', 'error'
 * @param data - Event data (structured object with event name and details)
 * @param options - Optional: tag for filtering, userId if authenticated
 */
export async function sendTelemetry(
  level: TelemetryLevel,
  data: Record<string, unknown>,
  options?: TelemetryOptions
): Promise<void> {
  try {
    // Check if telemetry is enabled
    const enabled = await isTelemetryEnabled();
    if (!enabled || (!TELEMETRY_URL && !SUPABASE_URL)) {
      return;
    }

    const deviceId = await getDeviceId();
    const tag = options?.tag || 'workstation';
    const launchCount = await configStore.getAppLaunchCount().catch(() => 0);
    const enrichedData = launchCount > 0
      ? {
          ...data,
          launchCount,
          isFirstLaunch: launchCount === 1,
        }
      : data;

    // Extract userId/email from auth token if available
    let userId = options?.userId;
    let authClaims: DecodedAuthClaims | undefined;
    if (!userId) {
      const { getAuthTokens } = await import('./configStore');
      const { access_token } = await getAuthTokens();
      if (access_token) {
        try {
          authClaims = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64url').toString()) as DecodedAuthClaims;
          userId = authClaims.sub;
        } catch {}
      }
    }

    const eventName = typeof enrichedData.event === 'string' ? enrichedData.event : 'unknown';
    const { event: _event, ...properties } = enrichedData;

    const payload = {
      level,
      date: Date.now(),
      data: { event: eventName, ...properties },
      variables: {
        deviceId,
        sessionId: getSessionId(),
        processType: 'main',
        ...(userId && { userId }),
      },
      client: {
        name: CLIENT_NAME,
        version: getAppVersion(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
    };

    const url = `${TELEMETRY_URL}?tag=${encodeURIComponent(tag)}`;
    const normalizedEmail = typeof authClaims?.email === 'string' ? authClaims.email.trim().toLowerCase() : '';
    const emailHash =
      normalizedEmail && ADS_IMPORTABLE_EVENTS.has(eventName)
        ? createHash('sha256').update(normalizedEmail).digest('hex')
        : undefined;
    const workstationProperties = emailHash
      ? { ...properties, email_hash: emailHash }
      : properties;

    const withTimeout = (p: Promise<unknown>) =>
      Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);

    const writes: Promise<unknown>[] = [];
    if (TELEMETRY_URL) {
      writes.push(withTimeout(fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })));
    }
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
      writes.push(withTimeout(writeWorkstationEvent(eventName, workstationProperties, {
        deviceId,
        sessionId: getSessionId(),
        userId,
        appVersion: getAppVersion(),
        platform: process.platform,
      })));
    }

    const results = await Promise.allSettled(writes);

    const [legacyWrite, workstationWrite] = results;
    if (legacyWrite?.status === 'rejected' && !hasWarnedAboutLegacyTelemetryFailure) {
      hasWarnedAboutLegacyTelemetryFailure = true;
      console.warn('[telemetry] Legacy telemetry write failed:', legacyWrite.reason);
    }
    if (workstationWrite?.status === 'rejected' && !hasWarnedAboutWorkstationEventsFailure) {
      hasWarnedAboutWorkstationEventsFailure = true;
      console.warn('[telemetry] workstation_events write failed:', workstationWrite.reason);
    }
  } catch (error) {
    // Telemetry should never crash the app - silently fail
    // Only log in development
    if (process.env.NODE_ENV === 'development') {
      console.error('Telemetry failed:', error);
    }
  }
}

// ============================================================================
// Direct Supabase write for workstation_events
// ============================================================================

async function writeWorkstationEvent(
  event: string,
  properties: Record<string, unknown>,
  meta: {
    deviceId: string;
    sessionId: string;
    userId?: string;
    appVersion: string;
    platform: string;
  }
): Promise<void> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/workstation_events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      event,
      device_id: meta.deviceId,
      session_id: meta.sessionId,
      user_id: meta.userId || null,
      properties,
      app_version: meta.appVersion,
      platform: meta.platform,
    }),
  });

  if (!response.ok) {
    throw new Error(`workstation_events write failed with status ${response.status}`);
  }
}

// ============================================================================
// Convenience functions for common events
// ============================================================================

/**
 * Track app launch
 */
export async function trackAppLaunch(): Promise<void> {
  await sendTelemetry('info', {
    event: 'app_launched',
    version: getAppVersion(),
    platform: process.platform,
    arch: process.arch,
  });
}

/**
 * Track feature usage
 */
export async function trackFeatureUsed(
  feature: string,
  details?: Record<string, unknown>
): Promise<void> {
  await sendTelemetry('info', {
    event: 'feature_used',
    feature,
    ...details,
  });
}

/**
 * Track errors/crashes
 */
export async function trackError(
  errorType: string,
  error: Error | string,
  context?: Record<string, unknown>
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : error;
  const errorStack = error instanceof Error ? error.stack : undefined;

  await sendTelemetry('error', {
    event: errorType,
    errorType,
    error: errorMessage,
    stack: errorStack,
    ...context,
  });
}

/**
 * Track onboarding events
 */
export async function trackOnboarding(
  step: string,
  details?: Record<string, unknown>
): Promise<void> {
  await sendTelemetry(
    'info',
    {
      event: 'onboarding',
      step,
      ...details,
    },
    { tag: 'onboarding' }
  );
}

/**
 * Track session duration (call on app exit)
 */
export async function trackSessionEnd(durationMs: number): Promise<void> {
  await sendTelemetry('info', {
    event: 'session_ended',
    durationMs,
    durationMinutes: Math.round(durationMs / 60000),
  });
}
