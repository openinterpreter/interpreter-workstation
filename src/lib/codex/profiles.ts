import type { JsonValue } from "../../../server/handlers/codex-generated-types/serde_json/JsonValue";
import { getInterpreterOpenRouterBaseUrl } from "../../../shared/hostedApi";
import {
  LOCAL_MODEL_PROVIDER_RUNTIMES,
  type LocalModelProviderRuntime,
} from "../../../shared/types/provider";
import type { WireApi } from "../../../shared/types/model";
import { DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID } from "../../../shared/utils/openAiResponsesTools";

import type { ProfileId } from "./profile-options";

export type { ProfileId };
export { isProfileId } from "./profile-options";

type ProviderConfig = {
  base_url: string;
  name: string;
  requires_openai_auth: boolean;
  wire_api: WireApi;
  experimental_bearer_token?: string;
  http_headers?: Record<string, string>;
};

export type Profile = {
  readonly id: string;
  readonly label: string;
  readonly modelProvider: string | null;
  readonly model?: string;
  /**
   * Undefined lets OIX select its recommended provider/model harness. Null
   * explicitly requests native Codex.
   */
  readonly harness?: string | null;
  readonly providerConfig?: ProviderConfig;
};

export type CustomPreset = {
  readonly id: ProfileId;
  readonly label: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly requiresApiKey: boolean;
  readonly wireApi: WireApi;
};

function getInterpreterBaseUrl(): string {
  return getInterpreterOpenRouterBaseUrl();
}

// Responses remains the default. Local runtimes (Ollama, LM Studio) default to
// Chat Completions because their upstream endpoints are more stable on it; the
// per-profile "Use Chat Completions" toggle overrides this either way.
export const CUSTOM_PRESETS: readonly CustomPreset[] = [
  {
    id: "ollama",
    label: "Ollama",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3.5:0.8b",
    requiresApiKey: false,
    wireApi: "chat",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    defaultBaseUrl: "https://ollama.com/v1",
    defaultModel: "",
    requiresApiKey: true,
    wireApi: "responses",
  },
  {
    // NOTE(victor): LM Studio now requires auth by default. We send "lm-studio"
    // as the default bearer token (see buildProfileFromPreset). LM Studio accepts
    // this as its built-in default. User-provided apiKey overrides it.
    id: "lmstudio",
    label: "LM Studio",
    defaultBaseUrl: "http://localhost:1234/v1",
    defaultModel: "",
    requiresApiKey: false,
    wireApi: "chat",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.6",
    requiresApiKey: true,
    wireApi: "responses",
  },
  {
    id: "openai-api",
    label: "OpenAI API",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID,
    requiresApiKey: true,
    wireApi: "responses",
  },
  {
    id: "nvidia",
    label: "NVIDIA",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "openai/gpt-oss-120b",
    requiresApiKey: true,
    wireApi: "responses",
  },
  {
    id: "groq",
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    requiresApiKey: true,
    wireApi: "responses",
  },
  {
    id: "xai",
    label: "xAI",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "",
    requiresApiKey: true,
    wireApi: "responses",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "",
    requiresApiKey: true,
    wireApi: "responses",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    requiresApiKey: true,
    wireApi: "chat",
  },
  {
    id: "custom",
    label: "Custom Endpoint",
    defaultBaseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    wireApi: "responses",
  },
] as const;

export function isCustomPreset(id: ProfileId): boolean {
  return CUSTOM_PRESETS.some((p) => p.id === id);
}

export function getCustomPreset(id: ProfileId): CustomPreset | undefined {
  return CUSTOM_PRESETS.find((p) => p.id === id);
}

export function withAuthToken(profile: Profile, token: string): Profile {
  if (!profile.providerConfig) return profile;
  return {
    ...profile,
    providerConfig: {
      ...profile.providerConfig,
      experimental_bearer_token: token,
      http_headers: { ...profile.providerConfig.http_headers, "x-api-key": token },
    },
  };
}

const OPENAI_PROFILE: Profile = {
  id: "default",
  label: "OpenAI",
  modelProvider: "openai",
};

const INTERPRETER_HOSTED_PROFILE: Profile = {
    id: "interpreter",
    label: "Interpreter",
    modelProvider: "interpreter",
    model: "interpreter-smart",
    providerConfig: {
      base_url: getInterpreterBaseUrl(),
      name: "Interpreter",
      requires_openai_auth: false,
      wire_api: "responses",
    },
};

// Keep the hosted profile definition available for persisted profiles and
// distribution builds. Community UI surfaces decide whether to offer it based
// on the configured hosted API; removing the runtime identity would make old
// conversations impossible to inspect after switching distributions.
export const PROFILES: readonly Profile[] = [
  OPENAI_PROFILE,
  INTERPRETER_HOSTED_PROFILE,
];

export function getProfile(id: ProfileId): Profile {
  const profile = PROFILES.find((p) => p.id === id);
  if (!profile) {
    throw new Error(`Unknown profile: ${id}`);
  }

  if (id === "interpreter" && profile.providerConfig) {
    return {
      ...profile,
      providerConfig: {
        ...profile.providerConfig,
        base_url: getInterpreterBaseUrl(),
      },
    };
  }

  return profile;
}

// NOTE(victor): App-managed local profiles are written back through
// configValueWrite() under model_providers.<modelProvider>. The runtime reserves
// the built-in OSS provider IDs "ollama" and "lmstudio"; writing those keys
// fails config validation and would also route through local setup/version
// checks. Only local presets get hashed IDs. Cloud presets such as
// "ollama-cloud" must stay explicit so they cannot be mistaken for local
// Ollama.
function isLocalProviderPresetId(id: ProfileId): id is LocalModelProviderRuntime {
  return LOCAL_MODEL_PROVIDER_RUNTIMES.includes(id as LocalModelProviderRuntime);
}

/** Simple deterministic hash (djb2) of a string, returned as a hex suffix. */
function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0; // h * 33 + c, keep 32-bit
  }
  return (h >>> 0).toString(16); // unsigned 32-bit hex
}

/**
 * OIX reserves every provider id in its built-in catalog. Workstation keeps
 * that exact id in the saved model profile for discovery and selection, but an
 * app-supplied endpoint/key must be provisioned under a private runtime id.
 */
export function buildAppManagedModelProviderId(providerId: string): string {
  const slug = providerId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "provider";
  return `interpreter-app-${slug}-${djb2Hex(providerId)}`;
}

export function buildProfileFromPreset(
  preset: CustomPreset,
  overrides?: { baseUrl?: string; apiKey?: string; model?: string; wireApi?: WireApi },
): Profile {
  const baseUrl = overrides?.baseUrl || preset.defaultBaseUrl;
  const apiKey = overrides?.apiKey;
  const effectiveApiKey = apiKey ?? (preset.id === "lmstudio" ? "lm-studio" : undefined);
  const model = overrides?.model || preset.defaultModel || undefined;

  const modelProvider = isLocalProviderPresetId(preset.id)
    ? `${preset.id}-${djb2Hex(baseUrl)}`
    : buildAppManagedModelProviderId(preset.id);

  return {
    id: preset.id,
    label: preset.label,
    modelProvider,
    model,
    providerConfig: baseUrl
        ? {
          base_url: baseUrl,
          name: preset.label,
          requires_openai_auth: false,
          wire_api: overrides?.wireApi ?? preset.wireApi,
          ...(effectiveApiKey
            ? {
                experimental_bearer_token: effectiveApiKey,
                http_headers: { Authorization: `Bearer ${effectiveApiKey}` },
              }
            : {}),
        }
      : undefined,
  };
}

export function providerConfigToJsonValue(config: ProviderConfig): JsonValue {
  const record: Record<string, JsonValue> = {
    base_url: config.base_url,
    name: config.name,
    requires_openai_auth: config.requires_openai_auth,
    wire_api: config.wire_api,
  };

  if (config.experimental_bearer_token) {
    record.experimental_bearer_token = config.experimental_bearer_token;
  }

  if (config.http_headers) {
    const headers: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(config.http_headers)) {
      headers[k] = v;
    }
    record.http_headers = headers;
  }

  return record;
}
