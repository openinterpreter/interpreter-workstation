import { distributionProductConfig } from './productConfig';

export const INTERPRETER_HOSTED_API_BASE_URL_ENV_VAR = 'INTERPRETER_HOSTED_API_BASE_URL';
export const INTERPRETER_OVERLAY_SERVER_URL_ENV_VAR = 'INTERPRETER_OVERLAY_SERVER_URL';
const DEFAULT_LOCAL_PYTHON_API_PORT = '18000';

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }

  return process.env[name];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function getInterpreterHostedApiOverrideBaseUrl(): string | null {
  const override = readEnv(INTERPRETER_HOSTED_API_BASE_URL_ENV_VAR)?.trim();
  if (!override) {
    return null;
  }

  return normalizeBaseUrl(override);
}

export function getInterpreterHostedApiBaseUrl(): string {
  const overrideBaseUrl = getInterpreterHostedApiOverrideBaseUrl();
  if (overrideBaseUrl) {
    return overrideBaseUrl;
  }

  if (readEnv('USE_LOCAL_API') === 'true') {
    const port = readEnv('PYTHON_API_PORT')?.trim() || DEFAULT_LOCAL_PYTHON_API_PORT;
    return `http://localhost:${port}`;
  }

  return normalizeBaseUrl(distributionProductConfig.hostedApiBaseUrl);
}

export function getInterpreterHostedApiV0BaseUrl(): string {
  const baseUrl = getInterpreterHostedApiBaseUrl();
  return baseUrl ? `${baseUrl}/v0` : '';
}

export function getInterpreterOverlayBaseUrl(): string {
  const explicitOverlayUrl = readEnv(INTERPRETER_OVERLAY_SERVER_URL_ENV_VAR)?.trim();
  if (explicitOverlayUrl) {
    return normalizeBaseUrl(explicitOverlayUrl);
  }

  const hostedApiOverride = getInterpreterHostedApiOverrideBaseUrl();
  if (hostedApiOverride) {
    return `${hostedApiOverride}/v0/workstation/interpreter-overlay`;
  }

  if (readEnv('USE_LOCAL_API') === 'true') {
    return 'http://localhost:8080/v0/workstation/interpreter-overlay';
  }

  const hostedApiV0BaseUrl = getInterpreterHostedApiV0BaseUrl();
  return hostedApiV0BaseUrl
    ? `${hostedApiV0BaseUrl}/workstation/interpreter-overlay`
    : '';
}

export function getInterpreterOpenRouterBaseUrl(): string {
  const baseUrl = getInterpreterHostedApiV0BaseUrl();
  return baseUrl ? `${baseUrl}/openrouter` : '';
}

export function getInterpreterFeedbackUrl(): string {
  const baseUrl = getInterpreterHostedApiV0BaseUrl();
  return baseUrl ? `${baseUrl}/feedback` : '';
}

export function getInterpreterTelemetryUrl(): string {
  const baseUrl = getInterpreterHostedApiV0BaseUrl();
  return baseUrl ? `${baseUrl}/telemetry` : '';
}
