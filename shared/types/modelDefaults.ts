import type { ModelProvider } from './model';
import { BUILTIN_PROVIDER_IDS, type ApiPreset, type SupportedOpenAIOAuthModel } from './provider';
import { DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID } from '../utils/openAiResponsesTools';

/**
 * Provider model defaults used when creating ad-hoc profiles.
 * Onboarding uses explicit hosted packs and a runtime-built OpenAI OAuth pack.
 */
export const PROVIDER_MODEL_DEFAULTS = {
  hosted: {
    main: 'interpreter-smart',
    fast: 'interpreter-fast',
    vision: 'interpreter-smart',
  },
} as const;

export const OLLAMA_RECOMMENDED_MODEL_IDS = ['qwen3.5:4b', 'qwen3.5:0.8b', 'qwen3.5:9b'] as const;
export const LM_STUDIO_RECOMMENDED_MODEL_IDS = ['qwen/qwen3.5-4b', 'qwen/qwen3.5-0.8b', 'qwen/qwen3.5-9b'] as const;
export const LOCAL_MODEL_DEFAULTS = {
  ollama: OLLAMA_RECOMMENDED_MODEL_IDS[0],
  lmstudio: LM_STUDIO_RECOMMENDED_MODEL_IDS[0],
} as const;

export const API_PROVIDER_MODEL_DEFAULTS = {
  openai: DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID,
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'anthropic/claude-opus-4.6',
  deepseek: 'deepseek-v4-flash',
} as const;

export type ApiProviderModelDefaultKey = keyof typeof API_PROVIDER_MODEL_DEFAULTS;
export type OnboardingOptionalModelPackId = `api:${ApiPreset}` | 'local:ollama' | 'local:lmstudio';

export const ONBOARDING_OPTIONAL_MODEL_PACK_ORDER: OnboardingOptionalModelPackId[] = [
  'api:openai',
  'api:anthropic',
  'local:ollama',
  'local:lmstudio',
  'api:openrouter',
  'api:groq',
  'api:deepseek',
];

export function getDefaultApiProviderModelId(
  provider: ApiProviderModelDefaultKey,
  models: Array<{ id: string }>,
): string | null {
  const preferredModelId = API_PROVIDER_MODEL_DEFAULTS[provider];
  return models.some((model) => model.id === preferredModelId)
    ? preferredModelId
    : models[0]?.id ?? null;
}

export function inferPreferredModelPackIdsFromOnboardingText(
  text: string,
): OnboardingOptionalModelPackId[] {
  const normalized = text.toLowerCase();
  const ids: OnboardingOptionalModelPackId[] = [];

  if (/\b(openai api|openai key|gpt-?4|gpt-?5|gpt)\b/.test(normalized)) {
    ids.push('api:openai');
  }
  if (/\b(anthropic|claude)\b/.test(normalized)) {
    ids.push('api:anthropic');
  }
  if (/\b(openrouter|open router)\b/.test(normalized)) {
    ids.push('api:openrouter');
  }
  if (/\bgroq\b/.test(normalized)) {
    ids.push('api:groq');
  }
  if (/\bdeepseek\b/.test(normalized)) {
    ids.push('api:deepseek');
  }
  if (/\bollama\b/.test(normalized)) {
    ids.push('local:ollama');
  }
  if (/\b(lm studio|lmstudio|lms)\b/.test(normalized)) {
    ids.push('local:lmstudio');
  }

  return ONBOARDING_OPTIONAL_MODEL_PACK_ORDER.filter((packId) => ids.includes(packId));
}

type OnboardingProfilePreferenceCandidate = {
  id: string;
  name: string;
  modelId: string;
};

function normalizeModelPreferenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasNormalizedModelMention(text: string, alias: string): boolean {
  if (alias.length < 3) {
    return false;
  }
  return ` ${text} `.includes(` ${alias} `);
}

function getProfilePreferenceAliases(profile: OnboardingProfilePreferenceCandidate): string[] {
  const modelIdParts = profile.modelId.split('/').filter(Boolean);
  return Array.from(new Set([
    profile.modelId,
    modelIdParts[modelIdParts.length - 1] ?? '',
    profile.name,
  ].map(normalizeModelPreferenceText).filter(Boolean)));
}

export function inferPreferredProfileIdFromOnboardingText(
  text: string,
  profiles: OnboardingProfilePreferenceCandidate[],
  defaultProfileId: string,
): string {
  const normalizedText = normalizeModelPreferenceText(text);
  if (!normalizedText) {
    return defaultProfileId;
  }

  let bestMatch: { profileId: string; aliasLength: number; profileIndex: number } | null = null;
  for (const [profileIndex, profile] of profiles.entries()) {
    const matchingAlias = getProfilePreferenceAliases(profile)
      .filter((alias) => hasNormalizedModelMention(normalizedText, alias))
      .sort((a, b) => b.length - a.length)[0];

    if (!matchingAlias) {
      continue;
    }

    if (
      !bestMatch
      || matchingAlias.length > bestMatch.aliasLength
      || (matchingAlias.length === bestMatch.aliasLength && profileIndex < bestMatch.profileIndex)
    ) {
      bestMatch = {
        profileId: profile.id,
        aliasLength: matchingAlias.length,
        profileIndex,
      };
    }
  }

  return bestMatch?.profileId ?? defaultProfileId;
}

export interface OnboardingPackProfile {
  id: string;
  name: string;
  provider: ModelProvider;
  providerId: string;
  modelId: string;
  baseURL?: string;
  codexProfileId?: string;
  helpDescription?: string;
}

export interface OnboardingModelPack {
  defaultProfileId: string;
  profiles: OnboardingPackProfile[];
}

/**
 * Explicit onboarding packs.
 * New users start with zero profiles and these are added after auth.
 */
export const ONBOARDING_MODEL_PACKS = {
  hosted: {
    defaultProfileId: 'onboarding:interpreter-smart',
    profiles: [
      {
        id: 'onboarding:interpreter-smart',
        name: 'Interpreter Smart',
        provider: 'hosted',
        providerId: BUILTIN_PROVIDER_IDS.HOSTED,
        modelId: PROVIDER_MODEL_DEFAULTS.hosted.main,
        helpDescription: 'Routes to the smartest model for the best price.',
      },
      {
        id: 'onboarding:interpreter-fast',
        name: 'Interpreter Fast',
        provider: 'hosted',
        providerId: BUILTIN_PROVIDER_IDS.HOSTED,
        modelId: PROVIDER_MODEL_DEFAULTS.hosted.fast,
        helpDescription: 'Routes to the fastest model for the best price.',
      },
    ],
  },
} as const satisfies Record<'hosted', OnboardingModelPack>;

function normalizeSupportedOpenAIOAuthModels(
  supportedModels: SupportedOpenAIOAuthModel[],
): SupportedOpenAIOAuthModel[] {
  return Array.from(
    new Map(
      supportedModels
        .map((model) => ({
          id: model.id.trim(),
          name: model.name.trim() || model.id.trim(),
          isDefault: model.isDefault,
        }))
        .filter((model) => model.id)
        .map((model) => [model.id, model] as const),
    ).values(),
  );
}

function toOnboardingModelSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

export function getDefaultOpenAIOAuthModelId(
  supportedModels: SupportedOpenAIOAuthModel[],
): string {
  const normalizedModels = normalizeSupportedOpenAIOAuthModels(supportedModels);

  if (normalizedModels.length === 0) {
    throw new Error('OpenAI OAuth returned no supported models');
  }

  return normalizedModels.find((model) => model.isDefault)?.id
    ?? normalizedModels[0].id;
}

export function buildOpenAIOAuthOnboardingPack(
  supportedModels: SupportedOpenAIOAuthModel[],
): OnboardingModelPack {
  const dedupedModels = normalizeSupportedOpenAIOAuthModels(supportedModels);

  if (dedupedModels.length === 0) {
    throw new Error('OpenAI OAuth returned no supported models');
  }

  const profiles: OnboardingPackProfile[] = dedupedModels.map((model) => ({
    id: `onboarding:openai-${toOnboardingModelSlug(model.id)}`,
    name: model.name,
    provider: 'openai-oauth',
    providerId: BUILTIN_PROVIDER_IDS.OPENAI_OAUTH,
    modelId: model.id,
  }));

  const defaultModelId = getDefaultOpenAIOAuthModelId(dedupedModels);

  const defaultProfileId = profiles.find((profile) => profile.modelId === defaultModelId)?.id;
  if (!defaultProfileId) {
    throw new Error(`OpenAI OAuth default model "${defaultModelId}" is missing from the onboarding pack`);
  }

  return {
    defaultProfileId,
    profiles,
  };
}

export function getOpenAIOAuthInitialSelectedProfileIds(
  pack: OnboardingModelPack,
  limit = 3,
): string[] {
  return Array.from(
    new Set([
      pack.defaultProfileId,
      ...pack.profiles.map((profile) => profile.id),
    ]),
  ).slice(0, limit);
}

export function getOnboardingModelPack(provider: 'hosted'): OnboardingModelPack {
  return ONBOARDING_MODEL_PACKS[provider];
}

export function getHostedOnboardingFastProfileId(pack: OnboardingModelPack): string {
  const fastProfile = pack.profiles.find((profile) => profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.fast);
  if (!fastProfile) {
    throw new Error(`Hosted onboarding pack is missing ${PROVIDER_MODEL_DEFAULTS.hosted.fast}`);
  }
  return fastProfile.id;
}
