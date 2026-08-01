import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BuiltinToolContext,
  BuiltinToolDefinition,
} from "../../builtinTools";
import {
  checkFileAccessPermissionAsync,
  getFileAccessDeniedMessage,
  resolvePathWithWorkspace,
} from "../../../utils/permissions";
import { resolveUnicodePath } from "../../../utils/unicodePath";
import { getCurrentWorkspace } from "../../../utils/workspace";
import {
  createDenialResponse,
  isOutsideWorkspace,
} from "../../filesystemGuard";
import {
  FalHttpError,
  ensureUniquePath,
  extensionFromUrlOrMime,
  extractInputParameters,
  extractOutputUrls,
  formatToolError,
  isLikelyFilePath,
  normalizeEndpointId,
  sanitizeFileName,
} from "./shared";
import {
  fetchMediaAiJson,
  runMediaAiProxyStream,
  uploadLocalFileToHostedMedia,
  type MediaRunResult,
} from "./proxy";

type UnknownRecord = Record<string, unknown>;

interface UploadedInputFile {
  parameter: string;
  local_path: string;
  uploaded_url: string;
}

interface FalModelSearchResponse {
  models?: UnknownRecord[];
}

interface SavedOutputFile {
  path: string;
  absolute_path: string;
  url: string;
  mime_type: string | null;
  size_bytes: number;
}

type ParsedInputArgResult =
  | {
      ok: true;
      value: UnknownRecord;
    }
  | {
      ok: false;
      error: string;
    };

type MediaProgressReporter = BuiltinToolContext["reportProgress"];

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRunMediaModelInputArg(
  value: unknown,
): ParsedInputArgResult {
  if (typeof value !== "string") {
    return {
      ok: false,
      error: "Error: input must be a JSON string representing an object.",
    };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return {
      ok: false,
      error:
        "Error: input must be a non-empty JSON string representing an object.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: `Error: input must be valid JSON. ${(error as Error).message}`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: "Error: input JSON must decode to an object.",
    };
  }

  return {
    ok: true,
    value: parsed,
  };
}

function toPositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return Math.max(min, Math.min(max, rounded));
}

function keyPathToParamName(keyPath: string): string {
  const lastDot = keyPath.lastIndexOf(".");
  let paramName = lastDot >= 0 ? keyPath.slice(lastDot + 1) : keyPath;

  while (paramName.endsWith("]")) {
    const openBracket = paramName.lastIndexOf("[");
    if (openBracket < 0) break;
    paramName = paramName.slice(0, openBracket);
  }

  return paramName.toLowerCase();
}

export function shouldUploadParam(keyPath: string, value: string): boolean {
  const normalizedParam = keyPathToParamName(keyPath);
  if (!normalizedParam.endsWith("_url") && !normalizedParam.endsWith("_urls"))
    return false;
  return isLikelyFilePath(value);
}

export function normalizeLocalPathInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) {
    return value;
  }

  try {
    return fileURLToPath(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid file URL "${value}": ${message}`);
  }
}

function formatProgressValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

async function emitMediaProgress(
  reporter: MediaProgressReporter | undefined,
  fields: Record<string, unknown>,
): Promise<void> {
  const parts = ["[MediaAI]"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    parts.push(`${key}=${formatProgressValue(value)}`);
  }
  const line = parts.join(" ");
  console.log(line);
  if (!reporter) {
    return;
  }
  try {
    await reporter(`${line}\n`);
  } catch (error) {
    console.warn(
      `[MediaAI] phase=progress_report_failed message=${JSON.stringify(formatToolError(error))}`,
    );
  }
}

async function transformInputValue(
  value: unknown,
  keyPath: string,
  context: BuiltinToolContext | undefined,
  workspace: string | null,
  uploadedInputs: UploadedInputFile[],
): Promise<unknown> {
  if (typeof value === "string" && shouldUploadParam(keyPath, value)) {
    const normalizedPathInput = normalizeLocalPathInput(value);
    const resolved = resolvePathWithWorkspace(normalizedPathInput, workspace);
    const resolvedUnicodePath = await resolveUnicodePath(resolved);

    if (
      context?.agentId &&
      !(await checkFileAccessPermissionAsync(
        context.agentId,
        resolvedUnicodePath,
        "read",
        workspace,
      ))
    ) {
      throw new Error(
        getFileAccessDeniedMessage(
          context.agentId,
          resolvedUnicodePath,
          "read",
          workspace,
        ),
      );
    }

    await emitMediaProgress(context?.reportProgress, {
      phase: "upload_input_start",
      parameter: keyPath,
      localPath: resolvedUnicodePath,
    });
    const uploadedUrl = await uploadLocalFileToHostedMedia(
      resolvedUnicodePath,
      context?.abortSignal,
    );
    uploadedInputs.push({
      parameter: keyPath,
      local_path: resolvedUnicodePath,
      uploaded_url: uploadedUrl,
    });
    await emitMediaProgress(context?.reportProgress, {
      phase: "upload_input_done",
      parameter: keyPath,
      localPath: resolvedUnicodePath,
    });
    return uploadedUrl;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(
        await transformInputValue(
          value[i],
          `${keyPath}[${i}]`,
          context,
          workspace,
          uploadedInputs,
        ),
      );
    }
    return out;
  }

  if (isRecord(value)) {
    const out: UnknownRecord = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      out[key] = await transformInputValue(
        child,
        childPath,
        context,
        workspace,
        uploadedInputs,
      );
    }
    return out;
  }

  return value;
}

function isImageExtension(ext: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"].includes(
    ext.toLowerCase(),
  );
}

function endpointStem(endpointId: string): string {
  return sanitizeFileName(endpointId.replace(/[\/]/g, "_"));
}

function buildOutputFileName(
  endpointId: string,
  outputFilename: string | undefined,
  index: number,
  total: number,
  extension: string,
): string {
  const safeExtension = extension || ".bin";
  if (outputFilename && outputFilename.trim().length > 0) {
    const original = outputFilename.trim();
    const extFromName = path.extname(original);
    const ext = extFromName || safeExtension;
    const baseName = extFromName
      ? original.slice(0, -extFromName.length)
      : original;
    const stem = sanitizeFileName(baseName);
    if (total > 1) {
      return `${stem}_${index + 1}${ext}`;
    }
    return `${stem}${ext}`;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = endpointStem(endpointId);
  if (total > 1) {
    return `${stem}_${timestamp}_${index + 1}${safeExtension}`;
  }
  return `${stem}_${timestamp}${safeExtension}`;
}

async function downloadOutputFile(
  url: string,
  endpointId: string,
  outputFilename: string | undefined,
  outputDir: string,
  workspace: string | null,
  index: number,
  total: number,
): Promise<SavedOutputFile> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download output file (${response.status} ${response.statusText}) from ${url}`,
    );
  }

  const mimeType = response.headers.get("content-type");
  const extension = extensionFromUrlOrMime(url, mimeType);
  const fileName = buildOutputFileName(
    endpointId,
    outputFilename,
    index,
    total,
    extension,
  );

  await mkdir(outputDir, { recursive: true });
  const targetPath = await ensureUniquePath(path.join(outputDir, fileName));

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await writeFile(targetPath, buffer);

  const relativePath = workspace
    ? path.relative(workspace, targetPath)
    : targetPath;
  return {
    path: relativePath,
    absolute_path: targetPath,
    url,
    mime_type: mimeType,
    size_bytes: buffer.length,
  };
}

function endpointIdFromModel(rawModel: UnknownRecord): string {
  const endpointIdRaw =
    typeof rawModel.endpoint_id === "string"
      ? rawModel.endpoint_id
      : typeof rawModel.id === "string"
        ? rawModel.id
        : "";
  return normalizeEndpointId(endpointIdRaw);
}

function isRequiredInputParameter(parameter: unknown): boolean {
  return isRecord(parameter) && parameter.required === true;
}

function sanitizeInline(text: string, maxLength = 140): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}...`;
}

function parameterType(parameter: unknown): string {
  if (!isRecord(parameter)) return "unknown";
  return typeof parameter.type === "string" && parameter.type.trim().length > 0
    ? parameter.type.trim()
    : "unknown";
}

function defaultPreview(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) return "";
  return serialized.length <= 40 ? serialized : `${serialized.slice(0, 40)}...`;
}

function exampleValueForType(name: string, parameter: unknown): unknown {
  if (
    isRecord(parameter) &&
    Object.prototype.hasOwnProperty.call(parameter, "default")
  ) {
    return parameter.default;
  }

  const type = parameterType(parameter);
  switch (type) {
    case "string":
      if (name.toLowerCase().includes("prompt")) {
        return "a detailed metallic bicycle gear on a plain white background";
      }
      return `<${name}>`;
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return `<${name}>`;
  }
}

function summarizeInputParameters(
  inputParameters: UnknownRecord,
  limit = 8,
): string[] {
  const entries = Object.entries(inputParameters).sort((a, b) => {
    const left = isRequiredInputParameter(a[1]) ? 0 : 1;
    const right = isRequiredInputParameter(b[1]) ? 0 : 1;
    if (left !== right) return left - right;
    return a[0].localeCompare(b[0]);
  });

  const truncatedCount = Math.max(entries.length - limit, 0);
  const lines = entries.slice(0, limit).map(([name, parameter]) => {
    const required = isRequiredInputParameter(parameter)
      ? "required"
      : "optional";
    const type = parameterType(parameter);

    let suffix = "";
    if (
      isRecord(parameter) &&
      Object.prototype.hasOwnProperty.call(parameter, "default")
    ) {
      suffix += `, default=${defaultPreview(parameter.default)}`;
    }
    if (
      isRecord(parameter) &&
      typeof parameter.description === "string" &&
      parameter.description.trim().length > 0
    ) {
      suffix += ` - ${sanitizeInline(parameter.description)}`;
    }
    return `- ${name} (${required}, ${type}${suffix})`;
  });

  if (truncatedCount > 0) {
    lines.push(`- ... ${truncatedCount} more parameter(s)`);
  }
  return lines;
}

function buildMinimalInputExample(
  inputParameters: UnknownRecord,
): UnknownRecord {
  const requiredEntries = Object.entries(inputParameters).filter(
    ([, parameter]) => isRequiredInputParameter(parameter),
  );
  const targetEntries =
    requiredEntries.length > 0
      ? requiredEntries
      : Object.entries(inputParameters).slice(0, 1);

  const input: UnknownRecord = {};
  for (const [name, parameter] of targetEntries) {
    input[name] = exampleValueForType(name, parameter);
  }
  return input;
}

async function fetchInputParametersForEndpoint(
  endpointId: string,
): Promise<UnknownRecord | null> {
  if (!endpointId) return null;

  const params = new URLSearchParams({
    q: endpointId,
    expand: "openapi-3.0",
    limit: "10",
  });

  const response = await fetchMediaAiJson<FalModelSearchResponse>(
    `/models?${params.toString()}`,
  );

  const models = Array.isArray(response.models) ? response.models : [];
  const normalizedEndpoint = normalizeEndpointId(endpointId);
  const matchedModel = models.find(
    (model) => endpointIdFromModel(model) === normalizedEndpoint,
  );
  if (!matchedModel) return null;

  const inputParameters = extractInputParameters(matchedModel);
  return Object.keys(inputParameters).length > 0 ? inputParameters : null;
}

export function buildValidationFailureMessage({
  endpointId,
  falErrorMessage,
  providedInput,
  inputParameters,
}: {
  endpointId: string;
  falErrorMessage: string;
  providedInput: UnknownRecord | null;
  inputParameters: UnknownRecord | null;
}): string {
  const providedKeys = providedInput ? Object.keys(providedInput) : [];
  const lines: string[] = [
    `Failed to run media model for "${endpointId}" because fal rejected the input (HTTP 422).`,
    `fal_error: ${falErrorMessage}`,
    `provided_input_keys: ${providedKeys.length > 0 ? providedKeys.join(", ") : "(none)"}`,
  ];

  if (!inputParameters) {
    lines.push("expected_input_parameters: unavailable for this endpoint");
    lines.push(
      "Use search_media_models first, then send run_media_model.input with all required fields.",
    );
    return lines.join("\n");
  }

  const requiredKeys = Object.entries(inputParameters)
    .filter(([, parameter]) => isRequiredInputParameter(parameter))
    .map(([name]) => name);
  const missingRequired = requiredKeys.filter(
    (key) => !providedKeys.includes(key),
  );
  lines.push(
    `missing_required_input_keys: ${missingRequired.length > 0 ? missingRequired.join(", ") : "(none)"}`,
  );

  lines.push("expected_input_parameters:");
  lines.push(...summarizeInputParameters(inputParameters));

  lines.push("minimal_valid_tool_call:");
  const minimalInputObject = buildMinimalInputExample(inputParameters);
  lines.push(
    JSON.stringify(
      {
        endpoint_id: endpointId,
        input: JSON.stringify(minimalInputObject),
      },
      null,
      2,
    ),
  );

  return lines.join("\n");
}

export const runMediaModelTool: BuiltinToolDefinition = {
  name: "run_media_model",
  description: `Run a fal.ai media model through Interpreter hosted media.

Before calling this tool:
- call \`estimate_media_cost\` for the chosen endpoint.
- tell the user the expected cost clearly before spending it, especially for video, 3D, or multi-output runs.
- if remaining balance matters, call \`builtin-interpreter__interpreter_usage_get\` and compare it to the estimate.

Input requirements:
- endpoint_id: exact fal endpoint ID (example: "fal-ai/nano-banana-pro/edit").
- input: JSON string that exactly matches the model schema from search_media_models.

URL/path handling for any input field ending in "_url" or "_urls" (including arrays like image_urls):
- "https://..." or "http://..." => passed through unchanged.
- "/Users/.../file.png" (absolute local path) => uploaded through the hosted media proxy first.
- "preview_frame.png" or "./preview_frame.png" (workspace-relative local path) => uploaded through the hosted media proxy first.
- "file:///Users/.../file.png" (file URL) => converted to local path, then uploaded through the hosted media proxy first.
- Any local path must exist on disk at runtime.

Example input for image editing endpoint:
{
  "prompt": "Keep the exact same laptop, change only background to blurred wood and plants",
  "image_urls": ["/Users/example/Projects/demo/preview_frame.png"],
  "resolution": "4K",
  "num_images": 4,
  "aspect_ratio": "auto",
  "output_format": "png"
}

Outputs are saved to workspace by default.`,
  inputSchema: {
    type: "object",
    properties: {
      endpoint_id: {
        type: "string",
        description: 'fal endpoint ID (for example: "fal-ai/flux/dev").',
      },
      input: {
        type: "string",
        description:
          'JSON string for the exact model input object. For image edit models, pass "image_urls" as an array of URL/path strings (http(s), absolute local path, workspace-relative path, or file:// URL). Local paths are auto-uploaded through the hosted media proxy.',
      },
      output_filename: {
        type: "string",
        description:
          "Optional output filename base. If multiple outputs are returned, numeric suffixes are added.",
      },
      output_dir: {
        type: "string",
        description:
          "Output directory (workspace-relative). Required when save_to_workspace is true.",
      },
      save_to_workspace: {
        type: "boolean",
        description:
          "If true (default), download output URLs to workspace files.",
        default: true,
      },
      timeout_seconds: {
        type: "number",
        description: "Timeout in seconds for queue execution (default 600).",
        default: 600,
      },
    },
    required: ["endpoint_id", "input"],
  },
  fileAccess: {
    mode: "write",
    pathArg: "output_dir",
  },
  mode: "write",
  fileTypes: ["*"],
  handler: async (
    args: Record<string, unknown>,
    context?: BuiltinToolContext,
  ) => {
    let endpointIdForError = "";
    let inputForError: UnknownRecord | null = null;
    try {
      const endpointIdRaw =
        typeof args.endpoint_id === "string" ? args.endpoint_id : "";
      const endpointId = normalizeEndpointId(endpointIdRaw);
      if (!endpointId) {
        return {
          content: [{ type: "text", text: "Error: endpoint_id is required." }],
          isError: true,
        };
      }
      endpointIdForError = endpointId;

      const parsedInput = parseRunMediaModelInputArg(args.input);
      if (parsedInput.ok === false) {
        return {
          content: [{ type: "text", text: parsedInput.error }],
          isError: true,
        };
      }
      inputForError = parsedInput.value;

      const timeoutSeconds = toPositiveInt(args.timeout_seconds, 600, 10, 3600);
      const saveToWorkspace = args.save_to_workspace !== false;
      const outputFilename =
        typeof args.output_filename === "string"
          ? args.output_filename
          : undefined;
      const outputDirArg =
        typeof args.output_dir === "string" && args.output_dir.trim().length > 0
          ? args.output_dir.trim()
          : null;

      const workspace = context?.workspace || getCurrentWorkspace();
      if (!workspace && saveToWorkspace) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No workspace is set. Set a workspace or call run_media_model with save_to_workspace=false.",
            },
          ],
          isError: true,
        };
      }
      if (saveToWorkspace && !outputDirArg) {
        return {
          content: [
            {
              type: "text",
              text: "Error: output_dir is required when save_to_workspace is true.",
            },
          ],
          isError: true,
        };
      }
      const requiredOutputDirArg = outputDirArg ?? undefined;

      const uploadedInputs: UploadedInputFile[] = [];
      await emitMediaProgress(context?.reportProgress, {
        phase: "prepare_input",
        endpointId,
      });
      const preparedInputValue = await transformInputValue(
        parsedInput.value,
        "",
        context,
        workspace,
        uploadedInputs,
      );
      if (!isRecord(preparedInputValue)) {
        return {
          content: [
            { type: "text", text: "Error: Prepared input became invalid." },
          ],
          isError: true,
        };
      }

      const start = Date.now();
      const runResult: MediaRunResult = await runMediaAiProxyStream(
        {
          endpointId,
          input: preparedInputValue,
          timeoutSeconds,
          signal: context?.abortSignal,
        },
        (fields) => emitMediaProgress(context?.reportProgress, fields),
      );
      const outputUrls =
        Array.isArray(runResult.output_urls) && runResult.output_urls.length > 0
          ? runResult.output_urls
          : extractOutputUrls(runResult.output);
      await emitMediaProgress(context?.reportProgress, {
        phase: "output_urls_resolved",
        endpointId,
        outputUrlCount: outputUrls.length,
      });

      let savedFiles: SavedOutputFile[] = [];
      if (saveToWorkspace && workspace && outputUrls.length > 0) {
        const resolvedOutputDir = resolvePathWithWorkspace(
          requiredOutputDirArg!,
          workspace,
        );
        if (await isOutsideWorkspace(resolvedOutputDir, workspace)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: output_dir must be inside workspace. Resolved path is outside workspace: ${resolvedOutputDir}`,
              },
            ],
            isError: true,
          };
        }
        const downloads: SavedOutputFile[] = [];
        await emitMediaProgress(context?.reportProgress, {
          phase: "download_outputs_start",
          endpointId,
          outputUrlCount: outputUrls.length,
          outputDir: resolvedOutputDir,
        });
        for (let i = 0; i < outputUrls.length; i += 1) {
          const saved = await downloadOutputFile(
            outputUrls[i],
            endpointId,
            outputFilename,
            resolvedOutputDir,
            workspace,
            i,
            outputUrls.length,
          );
          downloads.push(saved);
          await emitMediaProgress(context?.reportProgress, {
            phase: "download_output_saved",
            endpointId,
            savedPath: saved.absolute_path,
            sizeBytes: saved.size_bytes,
          });
        }
        savedFiles = downloads;
      }

      const elapsedSeconds = (Date.now() - start) / 1000;
      await emitMediaProgress(context?.reportProgress, {
        phase: "completed",
        endpointId,
        elapsedMs: Date.now() - start,
        outputUrlCount: outputUrls.length,
        savedFileCount: savedFiles.length,
      });
      const responsePayload: UnknownRecord = {
        success: true,
        endpoint_id: endpointId,
        request_id: runResult.request_id,
        uploaded_inputs: uploadedInputs,
        output: runResult.output,
        output_urls: outputUrls,
        saved_files: savedFiles,
        billable_units: runResult.billable_units,
        cost_usd: runResult.cost_usd,
        cost_unit: runResult.cost_unit,
        billing: runResult.billing ?? null,
        time_taken_seconds: elapsedSeconds,
      };

      const imagePaths = savedFiles
        .filter((file) => isImageExtension(path.extname(file.absolute_path)))
        .map((file) => file.absolute_path);

      return {
        content: [
          { type: "text", text: JSON.stringify(responsePayload, null, 2) },
        ],
        isError: false,
        imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
      };
    } catch (error) {
      const message = formatToolError(error);
      await emitMediaProgress(context?.reportProgress, {
        phase: "failed",
        endpointId: endpointIdForError || undefined,
        message,
      });
      if (message.startsWith("Operation denied by user")) {
        return createDenialResponse("run media model with local file input");
      }

      if (
        error instanceof FalHttpError &&
        error.status === 422 &&
        endpointIdForError
      ) {
        const inputParameters = await fetchInputParametersForEndpoint(
          endpointIdForError,
        ).catch(() => null);
        return {
          content: [
            {
              type: "text",
              text: buildValidationFailureMessage({
                endpointId: endpointIdForError,
                falErrorMessage: message,
                providedInput: inputForError,
                inputParameters,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: `Failed to run media model: ${message}` },
        ],
        isError: true,
      };
    }
  },
};
