import { afterEach, describe, expect, test } from 'bun:test';

import {
  getInterpreterFeedbackUrl,
  getInterpreterHostedApiBaseUrl,
  getInterpreterOpenRouterBaseUrl,
  getInterpreterOverlayBaseUrl,
  getInterpreterTelemetryUrl,
  INTERPRETER_HOSTED_API_BASE_URL_ENV_VAR,
  INTERPRETER_OVERLAY_SERVER_URL_ENV_VAR,
} from './hostedApi';

const ORIGINAL_USE_LOCAL_API = process.env.USE_LOCAL_API;
const ORIGINAL_PYTHON_API_PORT = process.env.PYTHON_API_PORT;
const ORIGINAL_HOSTED_API_BASE_URL = process.env.INTERPRETER_HOSTED_API_BASE_URL;
const ORIGINAL_OVERLAY_SERVER_URL = process.env.INTERPRETER_OVERLAY_SERVER_URL;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

afterEach(() => {
  restoreEnv('USE_LOCAL_API', ORIGINAL_USE_LOCAL_API);
  restoreEnv('PYTHON_API_PORT', ORIGINAL_PYTHON_API_PORT);
  restoreEnv(INTERPRETER_HOSTED_API_BASE_URL_ENV_VAR, ORIGINAL_HOSTED_API_BASE_URL);
  restoreEnv(INTERPRETER_OVERLAY_SERVER_URL_ENV_VAR, ORIGINAL_OVERLAY_SERVER_URL);
});

describe('hostedApi', () => {
  test('has no hosted API in the community distribution', () => {
    delete process.env.USE_LOCAL_API;
    delete process.env.PYTHON_API_PORT;
    delete process.env[INTERPRETER_HOSTED_API_BASE_URL_ENV_VAR];
    delete process.env[INTERPRETER_OVERLAY_SERVER_URL_ENV_VAR];

    expect(getInterpreterHostedApiBaseUrl()).toBe('');
    expect(getInterpreterOpenRouterBaseUrl()).toBe('');
    expect(getInterpreterFeedbackUrl()).toBe('');
    expect(getInterpreterTelemetryUrl()).toBe('');
    expect(getInterpreterOverlayBaseUrl()).toBe('');
  });

  test('uses a compatible local hosted API when USE_LOCAL_API is enabled', () => {
    process.env.USE_LOCAL_API = 'true';
    process.env.PYTHON_API_PORT = '19000';
    delete process.env[INTERPRETER_HOSTED_API_BASE_URL_ENV_VAR];
    delete process.env[INTERPRETER_OVERLAY_SERVER_URL_ENV_VAR];

    expect(getInterpreterHostedApiBaseUrl()).toBe('http://localhost:19000');
    expect(getInterpreterOpenRouterBaseUrl()).toBe('http://localhost:19000/v0/openrouter');
    expect(getInterpreterOverlayBaseUrl()).toBe('http://localhost:8080/v0/workstation/interpreter-overlay');
  });

  test('uses the explicit hosted API override when configured', () => {
    process.env.USE_LOCAL_API = 'true';
    process.env.PYTHON_API_PORT = '19000';
    process.env[INTERPRETER_HOSTED_API_BASE_URL_ENV_VAR] = 'https://api.example.test/';
    delete process.env[INTERPRETER_OVERLAY_SERVER_URL_ENV_VAR];

    expect(getInterpreterHostedApiBaseUrl()).toBe('https://api.example.test');
    expect(getInterpreterOpenRouterBaseUrl()).toBe('https://api.example.test/v0/openrouter');
    expect(getInterpreterFeedbackUrl()).toBe('https://api.example.test/v0/feedback');
    expect(getInterpreterTelemetryUrl()).toBe('https://api.example.test/v0/telemetry');
    expect(getInterpreterOverlayBaseUrl()).toBe('https://api.example.test/v0/workstation/interpreter-overlay');
  });

  test('uses an explicit overlay override independently of the hosted API', () => {
    delete process.env.USE_LOCAL_API;
    delete process.env[INTERPRETER_HOSTED_API_BASE_URL_ENV_VAR];
    process.env[INTERPRETER_OVERLAY_SERVER_URL_ENV_VAR] = 'https://overlay.example.test/custom/';

    expect(getInterpreterOverlayBaseUrl()).toBe('https://overlay.example.test/custom');
  });
});
