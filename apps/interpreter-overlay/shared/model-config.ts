interface InterpreterOverlayLlmOption {
  id: string;
  label: string;
  model: string;
  baseURL: string;
}

// The first option is the default when INTERPRETER_OVERLAY_LLM_PRESET is unset.
export const INTERPRETER_OVERLAY_LLM_OPTIONS = [
  {
    id: "groq-gpt-oss-120b",
    label: "Groq GPT-OSS 120B",
    model: "openai/gpt-oss-120b",
    baseURL: "https://api.groq.com/openai",
  },
  {
    id: "groq-gpt-oss-20b",
    label: "Groq GPT-OSS 20B",
    model: "openai/gpt-oss-20b",
    baseURL: "https://api.groq.com/openai",
  },
  {
    id: "openai-gpt-5-mini",
    label: "OpenAI GPT-5 Mini",
    model: "gpt-5-mini",
    baseURL: "https://api.openai.com",
  },
  {
    id: "openai-gpt-5.4-mini",
    label: "OpenAI GPT-5.4 Mini",
    model: "gpt-5.4-mini",
    baseURL: "https://api.openai.com",
  },
  {
    id: "cerebras-gpt-oss-120b",
    label: "Cerebras GPT-OSS 120B",
    model: "gpt-oss-120b",
    baseURL: "https://api.cerebras.ai/v1",
  },
] as const satisfies readonly InterpreterOverlayLlmOption[];

export const INTERPRETER_OVERLAY_MODEL_CANDIDATES = INTERPRETER_OVERLAY_LLM_OPTIONS.map(
  ({ model }) => model,
);

const FALLBACK_OPTION: InterpreterOverlayLlmOption = INTERPRETER_OVERLAY_LLM_OPTIONS[0];
const envPresetOverride = process.env.INTERPRETER_OVERLAY_LLM_PRESET?.trim();
const envModelOverride = process.env.INTERPRETER_OVERLAY_MODEL?.trim();
const envBaseUrlOverride = process.env.INTERPRETER_OVERLAY_LLM_BASE_URL?.trim();

function resolveOptionByModel(model: string): InterpreterOverlayLlmOption | undefined {
  return INTERPRETER_OVERLAY_LLM_OPTIONS.find(
    ({ model: candidateModel }) => candidateModel === model,
  );
}

function resolveDefaultOption() {
  let resolvedOption: InterpreterOverlayLlmOption = FALLBACK_OPTION;

  if (envPresetOverride) {
    const matchingOption = INTERPRETER_OVERLAY_LLM_OPTIONS.find(
      ({ id }) => id === envPresetOverride,
    );
    if (!matchingOption) {
      throw new Error(`Unknown INTERPRETER_OVERLAY_LLM_PRESET: ${envPresetOverride}`);
    }
    resolvedOption = matchingOption;
  }

  if (envModelOverride) {
    const matchingOption = resolveOptionByModel(envModelOverride);
    resolvedOption = matchingOption ?? {
      id: `custom:${envModelOverride}`,
      label: envModelOverride,
      model: envModelOverride,
      baseURL: resolvedOption.baseURL,
    };
  }

  if (envBaseUrlOverride) {
    resolvedOption = {
      ...resolvedOption,
      baseURL: envBaseUrlOverride,
    };
  }

  return resolvedOption;
}

const defaultOption = resolveDefaultOption();

export const DEFAULT_INTERPRETER_OVERLAY_LLM_PRESET = defaultOption.id;
export const DEFAULT_INTERPRETER_OVERLAY_MODEL = defaultOption.model;
export const DEFAULT_INTERPRETER_OVERLAY_LLM_BASE_URL = defaultOption.baseURL;
