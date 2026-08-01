import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { getCurrentServerAccessTokenSync } from "../../../lib/authTokens";
import { HOSTED_LLM_SERVER } from "../../../utils/hostedProvider";
import { FalHttpError } from "./shared";

type UnknownRecord = Record<string, unknown>;

const MEDIA_AI_PROXY_BASE = `${HOSTED_LLM_SERVER}/v0/media-ai`;
const MEDIA_UPLOAD_URL = `${HOSTED_LLM_SERVER}/v0/upload?bucket=user-uploads`;

export interface MediaRunResult {
  endpoint_id: string;
  request_id: string | null;
  output: UnknownRecord;
  output_urls: string[];
  billable_units: number | null;
  cost_usd: number | null;
  cost_unit: string | null;
  billing?: {
    updated_monthly_tokens: number;
    updated_purchased_tokens: number;
    tokens_not_deducted: number;
    estimated_interpreter_tokens?: number;
    estimated_interpreter_charge_usd?: number;
    charged_interpreter_tokens?: number;
    charged_interpreter_usd?: number;
    interpreter_token_price_usd?: number;
    interpreter_profit_margin_percent?: number;
  };
}

type StreamEvent =
  | { type: "progress"; fields?: Record<string, unknown> }
  | {
      type: "result";
      result?: MediaRunResult;
    }
  | {
      type: "error";
      error?: {
        message?: string;
        status?: number;
        status_text?: string;
        payload?: unknown;
        endpoint_description?: string;
      };
    };

function getHostedMediaAuthHeader(): { Authorization: string } {
  const accessToken = getCurrentServerAccessTokenSync();
  if (!accessToken) {
    throw new Error("You must be signed in to use Media AI tools.");
  }
  return { Authorization: `Bearer ${accessToken}` };
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toFalHttpError(
  endpointDescription: string,
  payload: unknown,
  status: number,
  statusText: string,
): FalHttpError {
  return new FalHttpError({
    endpointDescription,
    status,
    statusText,
    payload,
  });
}

export async function fetchMediaAiJson<T>(
  pathSuffix: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const authHeader = getHostedMediaAuthHeader();
  headers.set("Authorization", authHeader.Authorization);

  const body = init.body;
  if (body && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${MEDIA_AI_PROXY_BASE}${pathSuffix}`, {
    ...init,
    headers,
  });
  const payload = await parseResponsePayload(response);
  if (!response.ok) {
    throw toFalHttpError(
      `Hosted media proxy ${pathSuffix}`,
      payload,
      response.status,
      response.statusText,
    );
  }
  return payload as T;
}

export async function uploadLocalFileToHostedMedia(
  localPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const fileBuffer = await readFile(localPath);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBuffer], { type: "application/octet-stream" }),
    path.basename(localPath),
  );

  const response = await fetch(MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: getHostedMediaAuthHeader(),
    body: formData,
    signal,
  });
  const payload = await parseResponsePayload(response);
  if (!response.ok) {
    throw toFalHttpError(
      "Hosted media upload",
      payload,
      response.status,
      response.statusText,
    );
  }

  const record = payload as { url?: unknown };
  if (typeof record.url !== "string" || !record.url.trim()) {
    throw new Error(
      `Hosted media upload did not return a URL for "${localPath}".`,
    );
  }
  return record.url;
}

async function parseStreamEvent(line: string): Promise<StreamEvent> {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Hosted media proxy returned invalid stream JSON: ${message}`,
    );
  }
}

export async function runMediaAiProxyStream(
  args: {
    endpointId: string;
    input: UnknownRecord;
    timeoutSeconds: number;
    signal?: AbortSignal;
  },
  onProgress?: (fields: Record<string, unknown>) => Promise<void> | void,
): Promise<MediaRunResult> {
  const response = await fetch(`${MEDIA_AI_PROXY_BASE}/run`, {
    method: "POST",
    headers: {
      ...getHostedMediaAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint_id: args.endpointId,
      input: args.input,
      timeout_seconds: args.timeoutSeconds,
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    const payload = await parseResponsePayload(response);
    throw toFalHttpError(
      "Hosted media proxy /run",
      payload,
      response.status,
      response.statusText,
    );
  }

  if (!response.body) {
    throw new Error("Hosted media proxy run did not return a stream body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: MediaRunResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (rawLine) {
        const event = await parseStreamEvent(rawLine);
        if (event.type === "progress" && event.fields) {
          await onProgress?.(event.fields);
        } else if (event.type === "result" && event.result) {
          finalResult = event.result;
        } else if (event.type === "error") {
          const status =
            typeof event.error?.status === "number" ? event.error.status : 500;
          const statusText =
            typeof event.error?.status_text === "string"
              ? event.error.status_text
              : "";
          const payload =
            event.error?.payload ??
            event.error?.message ??
            "Hosted media proxy run failed.";
          throw toFalHttpError(
            event.error?.endpoint_description || "Hosted media proxy /run",
            payload,
            status,
            statusText,
          );
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }

    if (done) {
      break;
    }
  }

  const trailingLine = buffer.trim();
  if (trailingLine) {
    const event = await parseStreamEvent(trailingLine);
    if (event.type === "progress" && event.fields) {
      await onProgress?.(event.fields);
    } else if (event.type === "result" && event.result) {
      finalResult = event.result;
    } else if (event.type === "error") {
      const status =
        typeof event.error?.status === "number" ? event.error.status : 500;
      const statusText =
        typeof event.error?.status_text === "string"
          ? event.error.status_text
          : "";
      const payload =
        event.error?.payload ??
        event.error?.message ??
        "Hosted media proxy run failed.";
      throw toFalHttpError(
        event.error?.endpoint_description || "Hosted media proxy /run",
        payload,
        status,
        statusText,
      );
    }
  }

  if (!finalResult) {
    throw new Error("Hosted media proxy stream ended without a result.");
  }

  return finalResult;
}
