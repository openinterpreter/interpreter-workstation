import {
  detectLocalModelServerUrl,
  findSupportedResponsesApiBaseUrlOption,
  isDeepSeekApiBaseURL,
} from "../../../shared/types/provider";

export const PROFILE_IDS = [
  "default",
  "interpreter",
  "ollama",
  "ollama-cloud",
  "lmstudio",
  "openrouter",
  "openai-api",
  "nvidia",
  "groq",
  "xai",
  "fireworks",
  "deepseek",
  "custom",
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
export type EndpointBackedProfileId = Extract<
  ProfileId,
  | "ollama"
  | "ollama-cloud"
  | "lmstudio"
  | "openrouter"
  | "openai-api"
  | "nvidia"
  | "groq"
  | "xai"
  | "fireworks"
  | "deepseek"
  | "custom"
>;

export type ProfileOption = {
  readonly id: ProfileId;
  readonly label: string;
};

export const PROFILE_OPTIONS: readonly ProfileOption[] = [
  { id: "default", label: "OpenAI" },
  { id: "interpreter", label: "Interpreter" },
  { id: "ollama", label: "Ollama" },
  { id: "ollama-cloud", label: "Ollama Cloud" },
  { id: "lmstudio", label: "LM Studio" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai-api", label: "OpenAI API" },
  { id: "nvidia", label: "NVIDIA" },
  { id: "groq", label: "Groq" },
  { id: "xai", label: "xAI" },
  { id: "fireworks", label: "Fireworks AI" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "custom", label: "Custom Endpoint" },
] as const satisfies readonly ProfileOption[];

export function isProfileId(value: string): value is ProfileId {
  return (PROFILE_IDS as readonly string[]).includes(value);
}

export function inferProfileIdFromEndpoint(endpoint: string): EndpointBackedProfileId {
  const baseUrlOption = findSupportedResponsesApiBaseUrlOption(endpoint);
  switch (baseUrlOption?.id) {
    case "ollama-cloud":
      return "ollama-cloud";
    case "openrouter":
      return "openrouter";
    case "openai":
      return "openai-api";
    case "groq":
      return "groq";
    case "xai":
      return "xai";
    case "fireworks":
      return "fireworks";
  }

  // NOTE(victor): NVIDIA is not in SUPPORTED_RESPONSES_API_BASE_URLS because we
  // do not want to advertise it as a verified /responses endpoint. But if a
  // user already points a profile at NVIDIA, keep attempting via the legacy
  // runtime preset and let the provider/Codex response determine compatibility.
  const normalizedEndpoint = endpoint.trim().replace(/\/+$/, "");
  if (normalizedEndpoint === "https://integrate.api.nvidia.com/v1") {
    return "nvidia";
  }

  if (isDeepSeekApiBaseURL(endpoint)) {
    return "deepseek";
  }

  const localKind = detectLocalModelServerUrl(endpoint);
  if (localKind === "ollama") return "ollama";
  if (localKind === "lmstudio") return "lmstudio";
  return "custom";
}
