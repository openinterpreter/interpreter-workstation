import type { VisionPort, RelativeBBox } from '../../shared/ports.js';

interface ServerClientConfig {
  baseUrl: string;
  timeout?: number;
  getAccessToken: () => Promise<string> | string;
}

interface VisionRequest {
  id: string;
  operation: 'cache' | 'detect' | 'query';
  screenshotBase64?: string;
  screenshotPath?: string;
  query?: string;
}

interface VisionCacheResponse {
  cached: true;
}

interface VisionDetectBboxResponse {
  bbox: RelativeBBox;
}

interface VisionDetectTextResponse {
  text: string;
}

interface VisionQueryResponse {
  text: string;
}

type VisionDetectResponse = VisionDetectBboxResponse | VisionDetectTextResponse;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string }; message?: string };
    if (typeof payload?.error?.message === 'string' && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {}

  try {
    const text = await response.text();
    if (text.trim()) {
      return text.trim().slice(0, 500);
    }
  } catch {}

  return fallback;
}

export class ServerClient implements VisionPort {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly getAccessToken: () => Promise<string> | string;

  constructor(config: ServerClientConfig) {
    this.baseUrl = config.baseUrl;
    this.timeout = config.timeout ?? 10000;
    this.getAccessToken = config.getAccessToken;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const accessToken = await this.getAccessToken();
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async cache(id: string, screenshotBase64?: string, screenshotPath?: string): Promise<void> {
    if (!screenshotBase64 && !screenshotPath) {
      throw new Error('Vision cache requires screenshotBase64 or screenshotPath');
    }

    const request: VisionRequest = {
      id,
      operation: 'cache',
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      ...(screenshotPath ? { screenshotPath } : {}),
    };

    const response = await fetchWithTimeout(
      `${this.baseUrl}/vision`,
      {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify(request),
      },
      this.timeout,
    );

    if (!response.ok) {
      throw new Error(
        `Vision cache failed: ${response.status} ${await readErrorMessage(response, response.statusText)}`,
      );
    }

    const data = (await response.json()) as VisionCacheResponse;
    if (!data.cached) {
      throw new Error('Vision cache operation did not return success');
    }
  }

  async detect(
    id: string,
    query: string,
    screenshotBase64?: string,
    screenshotPath?: string,
  ): Promise<{ bbox: RelativeBBox } | { text: string }> {
    const request: VisionRequest = {
      id,
      operation: 'detect',
      query,
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      ...(screenshotPath ? { screenshotPath } : {}),
    };

    const response = await fetchWithTimeout(
      `${this.baseUrl}/vision`,
      {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify(request),
      },
      this.timeout,
    );

    if (!response.ok) {
      throw new Error(
        `Vision detect failed: ${response.status} ${await readErrorMessage(response, response.statusText)}`,
      );
    }

    const data = (await response.json()) as VisionDetectResponse;
    return data;
  }

  async query(
    id: string,
    query: string,
    screenshotBase64?: string,
    screenshotPath?: string,
  ): Promise<{ text: string }> {
    const request: VisionRequest = {
      id,
      operation: 'query',
      query,
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      ...(screenshotPath ? { screenshotPath } : {}),
    };

    const response = await fetchWithTimeout(
      `${this.baseUrl}/vision`,
      {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify(request),
      },
      this.timeout,
    );

    if (!response.ok) {
      throw new Error(
        `Vision query failed: ${response.status} ${await readErrorMessage(response, response.statusText)}`,
      );
    }

    const data = (await response.json()) as VisionQueryResponse;
    return { text: data.text };
  }
}
