import { stat } from "node:fs/promises";
import * as path from "node:path";

type UnknownRecord = Record<string, unknown>;

interface FalHttpErrorOptions {
  endpointDescription: string;
  status: number;
  statusText: string;
  payload: unknown;
}

export class FalHttpError extends Error {
  status: number;

  statusText: string;

  endpointDescription: string;

  payload: unknown;

  constructor({
    endpointDescription,
    status,
    statusText,
    payload,
  }: FalHttpErrorOptions) {
    const detail = extractFalErrorMessage(payload) || `${status} ${statusText}`;
    super(`fal request failed (${endpointDescription}): ${detail}`);
    this.name = "FalHttpError";
    this.status = status;
    this.statusText = statusText;
    this.endpointDescription = endpointDescription;
    this.payload = payload;
  }
}

function truncateForError(text: string, maxLen = 500): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function normalizeValidationLoc(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value
      .map((item) =>
        typeof item === "string" || typeof item === "number"
          ? String(item)
          : "",
      )
      .filter((item) => item.length > 0)
      .filter((item) => item !== "body");
    return parts.join(".");
  }
  if (typeof value === "string") {
    return value.trim().replace(/^body[./]?/, "");
  }
  return "";
}

function formatValidationIssue(issue: unknown): string | null {
  const issueRecord = asRecord(issue);
  if (!issueRecord) return null;

  const loc = normalizeValidationLoc(issueRecord.loc);
  const msg =
    typeof issueRecord.msg === "string"
      ? issueRecord.msg.trim()
      : typeof issueRecord.message === "string"
        ? issueRecord.message.trim()
        : typeof issueRecord.detail === "string"
          ? issueRecord.detail.trim()
          : "";
  const type =
    typeof issueRecord.type === "string" ? issueRecord.type.trim() : "";

  const pieces: string[] = [];
  if (loc.length > 0) {
    pieces.push(`${loc}:`);
  }
  if (msg.length > 0) {
    pieces.push(msg);
  }
  if (msg.length === 0 && type.length > 0) {
    pieces.push(type);
  }

  if (pieces.length === 0) return null;
  return pieces.join(" ");
}

function extractValidationMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => formatValidationIssue(item))
    .filter((item): item is string => Boolean(item));
}

function extractFalErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload.trim().length > 0 ? truncateForError(payload.trim()) : null;
  }

  const record = asRecord(payload);
  if (!record) return null;

  const detail = record.detail;
  const detailIssues = extractValidationMessages(detail);
  if (detailIssues.length > 0) {
    return truncateForError(detailIssues.join("; "));
  }

  const errorsIssues = extractValidationMessages(record.errors);
  if (errorsIssues.length > 0) {
    return truncateForError(errorsIssues.join("; "));
  }

  if (typeof detail === "string" && detail.trim().length > 0) {
    return truncateForError(detail.trim());
  }

  const detailRecord = asRecord(detail);
  if (detailRecord) {
    const detailIssue = formatValidationIssue(detailRecord);
    if (detailIssue) {
      return truncateForError(detailIssue);
    }
  }

  const message = record.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return truncateForError(message.trim());
  }

  const error = asRecord(record.error);
  if (error) {
    const errorDetail = error.detail;
    if (typeof errorDetail === "string" && errorDetail.trim().length > 0) {
      return truncateForError(errorDetail.trim());
    }
    const errorMessage = error.message;
    if (typeof errorMessage === "string" && errorMessage.trim().length > 0) {
      return truncateForError(errorMessage.trim());
    }
  }

  return null;
}

export function clampLimit(
  limit: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isLikelyFilePath(value: string): boolean {
  if (!value || value.trim().length === 0) return false;
  if (isHttpUrl(value)) return false;

  const trimmed = value.trim();
  if (trimmed.startsWith("data:")) return false;
  if (trimmed.startsWith("mailto:")) return false;
  if (trimmed.startsWith("tel:")) return false;

  return true;
}

function normalizedHint(input: string): string {
  return input.toLowerCase().replace(/[_\s]/g, "-");
}

export type MediaCategory =
  | "text-to-image"
  | "image-to-image"
  | "text-to-video"
  | "image-to-video"
  | "text-to-audio"
  | "text-to-3d"
  | "image-to-3d"
  | "other";

export function inferMediaCategory(
  endpointId: string,
  name?: string,
  description?: string,
): MediaCategory {
  const text = `${endpointId} ${name || ""} ${description || ""}`;
  const normalized = normalizedHint(text);

  const hasImage = normalized.includes("image");
  const hasVideo = normalized.includes("video");
  const hasAudio =
    normalized.includes("audio") ||
    normalized.includes("speech") ||
    normalized.includes("music");
  const has3d =
    normalized.includes("3d") ||
    normalized.includes("mesh") ||
    normalized.includes("model");
  const hasTextTo =
    normalized.includes("text-to") || normalized.includes("txt2");
  const hasImageTo =
    normalized.includes("image-to") || normalized.includes("img2");

  if (hasTextTo && hasImage) return "text-to-image";
  if (hasImageTo && hasImage) return "image-to-image";
  if (hasTextTo && hasVideo) return "text-to-video";
  if (hasImageTo && hasVideo) return "image-to-video";
  if (hasTextTo && hasAudio) return "text-to-audio";
  if (hasTextTo && has3d) return "text-to-3d";
  if (hasImageTo && has3d) return "image-to-3d";

  if (hasVideo) return "text-to-video";
  if (hasAudio) return "text-to-audio";
  if (has3d) return "text-to-3d";
  if (hasImage) return "text-to-image";

  return "other";
}

export function estimateTimeSeconds(category: MediaCategory): number {
  switch (category) {
    case "text-to-image":
    case "image-to-image":
      return 8;
    case "text-to-video":
    case "image-to-video":
      return 120;
    case "text-to-audio":
      return 20;
    case "text-to-3d":
    case "image-to-3d":
      return 60;
    default:
      return 30;
  }
}

function resolveSchemaRef(
  schema: UnknownRecord,
  openapi: UnknownRecord,
): UnknownRecord {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    return schema;
  }

  const parts = ref.slice(2).split("/");
  let current: unknown = openapi;
  for (const part of parts) {
    const currentRecord = asRecord(current);
    if (!currentRecord || !(part in currentRecord)) {
      return schema;
    }
    current = currentRecord[part];
  }

  const resolved = asRecord(current);
  return resolved || schema;
}

function pickRequestSchema(openapiRaw: unknown): UnknownRecord | null {
  const openapi = asRecord(openapiRaw);
  if (!openapi) return null;

  const paths = asRecord(openapi.paths);
  if (paths) {
    for (const pathEntry of Object.values(paths)) {
      const pathObj = asRecord(pathEntry);
      if (!pathObj) continue;
      const post = asRecord(pathObj.post);
      if (!post) continue;
      const requestBody = asRecord(post.requestBody);
      if (!requestBody) continue;

      const content = asRecord(requestBody.content);
      if (!content) continue;

      const appJson = asRecord(content["application/json"]);
      const firstContent = appJson || asRecord(Object.values(content)[0]);
      if (!firstContent) continue;

      const schemaRaw = asRecord(firstContent.schema);
      if (!schemaRaw) continue;
      return resolveSchemaRef(schemaRaw, openapi);
    }
  }

  const components = asRecord(openapi.components);
  const schemas = components ? asRecord(components.schemas) : null;
  if (!schemas) return null;

  const candidateNames = [
    "Input",
    "input",
    "Request",
    "request",
    "Body",
    "ModelInput",
  ];
  for (const name of candidateNames) {
    const schema = asRecord(schemas[name]);
    if (schema) return resolveSchemaRef(schema, openapi);
  }

  return null;
}

function simpleType(property: UnknownRecord): string {
  const type = property.type;
  if (typeof type === "string" && type.length > 0) return type;

  if (Array.isArray(property.enum) && property.enum.length > 0) {
    const first = property.enum[0];
    return typeof first;
  }

  return "unknown";
}

export function extractInputParameters(model: UnknownRecord): UnknownRecord {
  const openapiSchema = model.openapi_schema || model.openapi;
  const requestSchema = pickRequestSchema(openapiSchema);
  if (!requestSchema) return {};

  const requiredRaw = Array.isArray(requestSchema.required)
    ? requestSchema.required
    : [];
  const required = new Set(
    requiredRaw.filter((entry): entry is string => typeof entry === "string"),
  );
  const properties = asRecord(requestSchema.properties);
  if (!properties) return {};

  const result: UnknownRecord = {};
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = asRecord(rawProperty) || {};
    const optionsRaw = Array.isArray(property.enum) ? property.enum : undefined;
    const options =
      optionsRaw &&
      optionsRaw.every((v) =>
        ["string", "number", "boolean"].includes(typeof v),
      )
        ? optionsRaw
        : undefined;

    const normalizedProperty: UnknownRecord = {
      type: simpleType(property),
      required: required.has(name),
    };

    if (
      typeof property.description === "string" &&
      property.description.trim().length > 0
    ) {
      normalizedProperty.description = property.description.trim();
    }
    if (property.default !== undefined) {
      normalizedProperty.default = property.default;
    }
    if (options && options.length > 0) {
      normalizedProperty.options = options;
    }
    if (typeof property.minimum === "number") {
      normalizedProperty.minimum = property.minimum;
    }
    if (typeof property.maximum === "number") {
      normalizedProperty.maximum = property.maximum;
    }

    result[name] = normalizedProperty;
  }

  return result;
}

export function sanitizeFileName(input: string): string {
  const trimmed = input.trim();
  const withoutInvalid = trimmed.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const collapsed = withoutInvalid.replace(/\s+/g, "_");
  const clean = collapsed.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return clean.length > 0 ? clean : "media_output";
}

function guessExtensionFromMimeType(contentType: string | null): string {
  if (!contentType) return "";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/flac": ".flac",
    "application/json": ".json",
    "model/gltf+json": ".gltf",
    "model/gltf-binary": ".glb",
  };
  return map[mime] || "";
}

export function extensionFromUrlOrMime(
  url: string,
  contentType: string | null,
): string {
  try {
    const parsed = new URL(url);
    const extFromPath = path.extname(parsed.pathname);
    if (extFromPath) return extFromPath;
  } catch {
    // Ignore URL parsing errors
  }
  return guessExtensionFromMimeType(contentType);
}

export async function ensureUniquePath(basePath: string): Promise<string> {
  let candidate = basePath;
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;

  let counter = 2;
  while (true) {
    try {
      await stat(candidate);
      candidate = path.join(dir, `${path.basename(stem)}_${counter}${ext}`);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

const OUTPUT_HINT_KEYS = [
  "url",
  "image",
  "video",
  "audio",
  "file",
  "output",
  "result",
  "mesh",
  "model",
];

function shouldCaptureUrl(url: string, keyPath: string): boolean {
  if (!isHttpUrl(url)) return false;

  const lowerKeyPath = keyPath.toLowerCase();
  if (OUTPUT_HINT_KEYS.some((key) => lowerKeyPath.includes(key))) {
    return true;
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("fal.media")) return true;
  } catch {
    return false;
  }

  return false;
}

function collectUrls(
  node: unknown,
  keyPath: string,
  output: Set<string>,
): void {
  if (typeof node === "string") {
    if (shouldCaptureUrl(node, keyPath)) {
      output.add(node);
    }
    return;
  }

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      collectUrls(node[i], `${keyPath}[${i}]`, output);
    }
    return;
  }

  const record = asRecord(node);
  if (!record) return;

  for (const [key, value] of Object.entries(record)) {
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    collectUrls(value, childPath, output);
  }
}

export function extractOutputUrls(result: unknown): string[] {
  const urls = new Set<string>();
  collectUrls(result, "", urls);
  return Array.from(urls);
}

export function normalizeEndpointId(endpointId: string): string {
  return endpointId.trim().replace(/^\/+/, "");
}

export function formatToolError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
