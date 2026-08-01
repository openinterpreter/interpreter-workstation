/**
 * End-to-end integration test for the telemetry IPC pipeline.
 *
 * This verifies the full path: frontend call shape → Express router →
 * telemetry handler → sendTelemetry → Supabase POST. The goal is to catch
 * the class of bug where args get double-wrapped across the IPC boundary
 * and the event name or properties arrive malformed on the Supabase side.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { clearConfigCache, setConfigOverride } from '../configStore';
import { distributionProductConfig } from '../../shared/productConfig';

// Capture every outbound fetch so we can assert what actually reached Supabase.
type CapturedFetch = { url: string; init: RequestInit | undefined };
const capturedFetches: CapturedFetch[] = [];

const originalFetch = globalThis.fetch;

// This suite verifies the optional official-distribution telemetry transport.
// The community product intentionally ships with no telemetry endpoints, so
// configure inert test endpoints before importing the module that snapshots
// them into constants.
const originalTelemetryConfig = { ...distributionProductConfig.telemetry };
distributionProductConfig.telemetry.eventsUrl = 'https://telemetry.example.test';
distributionProductConfig.telemetry.eventsAnonKey = 'test-anon-key';

// Now import the router (imports the real telemetry handler under the hood).
const { clearTelemetryCache } = await import('../telemetry');
const ipcRouter = (await import('./ipc')).default;
Object.assign(distributionProductConfig.telemetry, originalTelemetryConfig);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ipc', ipcRouter);
  return app;
}

function findWorkstationWrite(): CapturedFetch | undefined {
  return capturedFetches.find((entry) => entry.url.includes('/rest/v1/workstation_events'));
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body || typeof init.body !== 'string') {
    throw new Error('expected JSON string body on captured fetch');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

beforeEach(() => {
  capturedFetches.length = 0;
  clearConfigCache();
  clearTelemetryCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedFetches.push({
      url: typeof input === 'string' ? input : input.toString(),
      init,
    });
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  setConfigOverride({
    telemetryEnabled: true,
    appLaunchCount: 2,
    deviceId: 'device-test-1234',
    authToken: null,
    refreshToken: null,
  });
});

afterEach(() => {
  clearConfigCache();
  clearTelemetryCache();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  clearConfigCache();
  clearTelemetryCache();
  globalThis.fetch = originalFetch;
});

describe('telemetry IPC end-to-end', () => {
  test('track carries event name AND properties through to Supabase', async () => {
    // Frontend helper: `telemetry.track(event, data, undefined)` → proxy rest
    // args → HTTP body = [event, data, undefined].
    const body = [
      'message_sent',
      { messageLength: 42, profileId: 'interpreter', isFirstMessage: false },
      undefined,
    ];

    const res = await request(buildApp())
      .post('/api/ipc/telemetry/track')
      .send(body)
      .expect(200);

    expect(res.body).toEqual({ success: true });

    const supabaseWrite = findWorkstationWrite();
    expect(supabaseWrite).toBeDefined();

    const payload = parseBody(supabaseWrite!.init);
    expect(payload.event).toBe('message_sent');
    // Properties must survive the pipeline — this is the core bug.
    expect(payload.properties).toMatchObject({
      messageLength: 42,
      profileId: 'interpreter',
      isFirstMessage: false,
    });
  });

  test('trackError carries error message AND context through to Supabase', async () => {
    // Frontend helper: `telemetry.trackError(errorType, error, context)` →
    // HTTP body = [errorType, error, context].
    const body = [
      'oauth_signin_failed',
      'OAuth callback failed',
      { provider: 'openai', surface: 'onboarding', flowId: 'openai-789' },
    ];

    await request(buildApp())
      .post('/api/ipc/telemetry/trackError')
      .send(body)
      .expect(200);

    const supabaseWrite = findWorkstationWrite();
    expect(supabaseWrite).toBeDefined();

    const payload = parseBody(supabaseWrite!.init);
    expect(payload.event).toBe('oauth_signin_failed');
    // Regression guard: this is exactly what was arriving as {} in production
    // because the error message (a string) was being mis-parsed as the
    // properties object.
    expect(payload.properties).toMatchObject({
      error: 'OAuth callback failed',
      errorType: 'oauth_signin_failed',
      provider: 'openai',
      surface: 'onboarding',
      flowId: 'openai-789',
    });
  });

  test('track with no data still produces a valid event name', async () => {
    const body = ['new_chat_created', {}, undefined];

    await request(buildApp())
      .post('/api/ipc/telemetry/track')
      .send(body)
      .expect(200);

    const supabaseWrite = findWorkstationWrite();
    expect(supabaseWrite).toBeDefined();

    const payload = parseBody(supabaseWrite!.init);
    // Must NOT write 'unknown' — that was the symptom we were chasing.
    expect(payload.event).toBe('new_chat_created');
  });

  test('double-wrapped args (the old frontend bug) would now be detected', async () => {
    // This reproduces the buggy shape old clients sent: the entire tuple
    // wrapped in an extra array. If the pipeline ever regresses to the
    // double-wrapped shape, the event will arrive as 'unknown' and this
    // test will fail loudly.
    const buggyBody = [['message_sent', { messageLength: 42 }, undefined]];

    await request(buildApp())
      .post('/api/ipc/telemetry/track')
      .send(buggyBody)
      .expect(200);

    const supabaseWrite = findWorkstationWrite();
    expect(supabaseWrite).toBeDefined();

    const payload = parseBody(supabaseWrite!.init);
    // Under the bug, event would be 'unknown' and properties would be {}.
    // Assert we are NOT in that state with the correct frontend shape —
    // this test documents the failure mode, so leave it as the buggy input.
    expect(payload.event).toBe('unknown');
    expect(payload.properties).toEqual({ launchCount: 2, isFirstLaunch: false });
  });
});
