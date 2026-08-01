import type { BuiltinToolDefinition } from "../../builtinTools";
import {
  MediaCategory,
  clampLimit,
  estimateTimeSeconds,
  extractInputParameters,
  formatToolError,
  inferMediaCategory,
  normalizeEndpointId,
} from "./shared";
import { fetchMediaAiJson } from "./proxy";

type UnknownRecord = Record<string, unknown>;

interface FalModelSearchResponse {
  models?: UnknownRecord[];
  next_cursor?: string | null;
  has_more?: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const ALLOWED_CATEGORIES: Array<MediaCategory | "all"> = [
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "text-to-audio",
  "text-to-3d",
  "image-to-3d",
  "all",
];

function pickCategory(value: unknown): MediaCategory | "all" {
  if (typeof value !== "string") return "all";
  const normalized = value.trim().toLowerCase() as MediaCategory | "all";
  return ALLOWED_CATEGORIES.includes(normalized) ? normalized : "all";
}

function mapModel(rawModel: UnknownRecord): UnknownRecord {
  const metadata = isRecord(rawModel.metadata) ? rawModel.metadata : {};

  const endpointIdRaw =
    typeof rawModel.endpoint_id === "string"
      ? rawModel.endpoint_id
      : typeof rawModel.id === "string"
        ? rawModel.id
        : "";
  const endpointId = normalizeEndpointId(endpointIdRaw);
  const name =
    typeof metadata.display_name === "string"
      ? metadata.display_name
      : typeof rawModel.name === "string"
        ? rawModel.name
        : endpointId;
  const description =
    typeof metadata.description === "string"
      ? metadata.description
      : typeof rawModel.description === "string"
        ? rawModel.description
        : "";

  const metadataCategory =
    typeof metadata.category === "string"
      ? metadata.category.toLowerCase()
      : "";
  const category = ALLOWED_CATEGORIES.includes(
    metadataCategory as MediaCategory,
  )
    ? (metadataCategory as MediaCategory)
    : inferMediaCategory(endpointId, name, description);
  const inputParameters = extractInputParameters(rawModel);

  return {
    endpoint_id: endpointId,
    name,
    category,
    description,
    input_parameters: inputParameters,
    estimated_time_seconds: estimateTimeSeconds(category),
  };
}

export const searchMediaModelsTool: BuiltinToolDefinition = {
  name: "search_media_models",
  description: `Search for media generation models on fal.ai.

Use this before running a model to discover endpoint IDs, input parameters, and expected task types.

After choosing a candidate model, call \`estimate_media_cost\` before \`run_media_model\` so you can explain the expected price to the user.`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Search query. Example: "image upscaler", "text to video", "remove background".',
      },
      category: {
        type: "string",
        enum: ALLOWED_CATEGORIES,
        description: "Optional category filter.",
        default: "all",
      },
      limit: {
        type: "number",
        description: "Max number of results to return (1-10).",
        default: 5,
      },
    },
    required: ["query"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args: Record<string, unknown>) => {
    try {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return {
          content: [{ type: "text", text: "Error: query is required." }],
          isError: true,
        };
      }

      const category = pickCategory(args.category);
      const limit = clampLimit(args.limit, 5, 1, 10);

      const params = new URLSearchParams({
        q: query,
        expand: "openapi-3.0",
        limit: "10",
      });

      const response = await fetchMediaAiJson<FalModelSearchResponse>(
        `/models?${params.toString()}`,
      );

      const models = Array.isArray(response.models) ? response.models : [];
      const mapped = models
        .map(mapModel)
        .filter((model) => {
          if (category === "all") return true;
          return model.category === category;
        })
        .slice(0, limit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                category,
                models: mapped,
                has_more:
                  Boolean(response.has_more) || models.length > mapped.length,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to search fal models: ${formatToolError(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
};
