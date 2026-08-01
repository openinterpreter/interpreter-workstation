import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  OpenRouterModel,
  OpenRouterModelCatalogResult,
} from '../../shared/types/provider';
import {
  GENERIC_REASONING_DEFAULT_EFFORT,
  GENERIC_REASONING_EFFORTS,
  type ReasoningEffort,
} from '../../shared/types/reasoning';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models?supported_parameters=tools';
const OPENROUTER_CACHE_DIR = join(homedir(), '.interpreter');
const OPENROUTER_CACHE_FILE = join(OPENROUTER_CACHE_DIR, 'openrouter-models.json');

export const OPENROUTER_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface OpenRouterModelCacheFile {
  fetchedAt: number;
  models: OpenRouterModel[];
}

interface OpenRouterApiModel {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  supported_parameters?: string[];
}

interface OpenRouterApiResponse {
  data?: OpenRouterApiModel[];
}

interface OpenRouterModelCatalogServiceDeps {
  now: () => number;
  readCache: () => Promise<OpenRouterModelCacheFile | null>;
  writeCache: (cache: OpenRouterModelCacheFile) => Promise<void>;
  fetchRemoteModels: () => Promise<OpenRouterApiModel[]>;
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeOpenRouterModel(model: OpenRouterApiModel): OpenRouterModel {
  const id = normalizeText(model.id);
  if (!id) {
    throw new Error('OpenRouter model is missing an id');
  }

  const supportedParameters = Array.isArray(model.supported_parameters)
    ? new Set(
      model.supported_parameters
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase()),
    )
    : null;
  const supportedReasoningEfforts: ReasoningEffort[] | undefined = supportedParameters?.has('reasoning')
    ? [...GENERIC_REASONING_EFFORTS]
    : undefined;

  return {
    id,
    name: normalizeText(model.name) || id,
    provider: id.split('/')[0] || id,
    description: normalizeText(model.description),
    contextLength: typeof model.context_length === 'number' ? model.context_length : undefined,
    supportedReasoningEfforts,
    defaultReasoningEffort: supportedReasoningEfforts?.length
      ? GENERIC_REASONING_DEFAULT_EFFORT
      : undefined,
  };
}

function dedupeModels(models: OpenRouterModel[]): OpenRouterModel[] {
  return Array.from(
    new Map(models.map((model) => [model.id, model] as const)).values(),
  );
}

async function readOpenRouterModelCache(): Promise<OpenRouterModelCacheFile | null> {
  try {
    const raw = await readFile(OPENROUTER_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OpenRouterModelCacheFile>;
    if (
      typeof parsed.fetchedAt !== 'number'
      || !Array.isArray(parsed.models)
    ) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      models: parsed.models,
    };
  } catch {
    return null;
  }
}

async function writeOpenRouterModelCache(cache: OpenRouterModelCacheFile): Promise<void> {
  await mkdir(OPENROUTER_CACHE_DIR, { recursive: true });
  await writeFile(OPENROUTER_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

async function fetchOpenRouterModels(): Promise<OpenRouterApiModel[]> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch OpenRouter models: HTTP ${response.status}`);
  }

  const body = await response.json() as OpenRouterApiResponse;
  if (!Array.isArray(body.data)) {
    throw new Error('OpenRouter models response is missing data');
  }

  return body.data;
}

function isCacheStale(cache: OpenRouterModelCacheFile, now: number): boolean {
  return now - cache.fetchedAt >= OPENROUTER_MODEL_CACHE_TTL_MS;
}

export function createOpenRouterModelCatalogService(
  deps: OpenRouterModelCatalogServiceDeps,
) {
  let backgroundRefresh: Promise<void> | null = null;

  const refresh = async (): Promise<OpenRouterModelCatalogResult> => {
    const fetchedAt = deps.now();
    const models = dedupeModels(
      (await deps.fetchRemoteModels()).map(normalizeOpenRouterModel),
    );
    await deps.writeCache({ fetchedAt, models });
    return {
      models,
      fetchedAt,
      stale: false,
    };
  };

  const refreshInBackground = (): void => {
    if (backgroundRefresh) {
      return;
    }

    backgroundRefresh = (async () => {
      try {
        await refresh();
      } catch (error) {
        console.warn('[OpenRouterModelCatalog] Background refresh failed:', error);
      } finally {
        backgroundRefresh = null;
      }
    })();
  };

  return {
    async listModels(options?: { forceRefresh?: boolean }): Promise<OpenRouterModelCatalogResult> {
      if (options?.forceRefresh) {
        return refresh();
      }

      const cache = await deps.readCache();
      if (!cache) {
        return refresh();
      }

      if (!isCacheStale(cache, deps.now())) {
        return {
          ...cache,
          stale: false,
        };
      }

      refreshInBackground();
      return {
        ...cache,
        stale: true,
      };
    },
  };
}

export const openRouterModelCatalog = createOpenRouterModelCatalogService({
  now: () => Date.now(),
  readCache: readOpenRouterModelCache,
  writeCache: writeOpenRouterModelCache,
  fetchRemoteModels: fetchOpenRouterModels,
});
