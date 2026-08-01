import Fuse from 'fuse.js';
import type { OpenRouterModel, SupportedOpenAIOAuthModel } from '../../shared/types/provider';
import {
  isOpenAiModelId,
  supportsOpenAiResponsesCustomTools,
} from '../../shared/utils/openAiResponsesTools';

interface InterpreterModelOption {
  id: string;
  name: string;
}

/**
 * Map the runtime's OpenRouter model list (`interpreter/model/list` for the
 * `openrouter` provider) into the picker's `OpenRouterModel` shape. The runtime
 * exposes slug ids like `anthropic/claude-sonnet-4.6`; the provider segment is
 * the slug prefix, matching how `GENERATED_OPENROUTER_CATALOG` derives it so
 * browse grouping stays identical. Reasoning metadata is carried through.
 * Dedupes by id, drops empty ids, and drops runtime alias slugs (`~`-prefixed,
 * e.g. `~anthropic/claude-sonnet-latest`) that mirror a concrete versioned model
 * and would otherwise render as a duplicate `~provider` group sorted to the top.
 */
export function interpreterModelsToOpenRouterModels(
  models: SupportedOpenAIOAuthModel[],
): OpenRouterModel[] {
  const byId = new Map<string, OpenRouterModel>();
  for (const model of models) {
    const id = model.id.trim();
    // Alias slugs (`~`-prefixed) resolve to a concrete model the picker already lists; skip them.
    if (!id || id.startsWith('~') || byId.has(id)) continue;
    byId.set(id, {
      id,
      name: model.name.trim() || id,
      provider: id.split('/')[0] || 'openrouter',
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
    });
  }
  return Array.from(byId.values());
}

export interface HostedModelPickerItem {
  id: string;
  name: string;
  secondaryLabel: string;
  provider: string;
  description: string;
}

export interface HostedModelPickerGroup {
  id: string;
  label: string;
  items: HostedModelPickerItem[];
}

function normalizeHostedModelText(value: string): string {
  return value.trim().toLowerCase();
}

const HOSTED_MODEL_FUSE_OPTIONS = {
  threshold: 0.4,
  ignoreLocation: true,
} as const;

export function shouldSuppressHostedModelInDefaultBrowse(input: {
  name: string;
  id: string;
  provider: string;
}): boolean {
  const normalizedName = normalizeHostedModelText(input.name);
  const normalizedId = normalizeHostedModelText(input.id);
  const normalizedProvider = normalizeHostedModelText(input.provider);

  return (
    normalizedName.includes('a121')
    || normalizedId.includes('a121')
    || normalizedName.includes('ai21')
    || normalizedId.includes('ai21')
    || normalizedProvider.includes('ai21')
  );
}

export function isHostedModelToolCapable(model: Pick<OpenRouterModel, 'id' | 'provider'>): boolean {
  if (normalizeHostedModelText(model.provider) !== 'openai' && !isOpenAiModelId(model.id)) {
    return true;
  }
  return supportsOpenAiResponsesCustomTools(model.id);
}

export function filterHostedToolCapableModels(models: OpenRouterModel[]): OpenRouterModel[] {
  return models.filter(isHostedModelToolCapable);
}

function compareItems(a: HostedModelPickerItem, b: HostedModelPickerItem): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function fuzzySearchHostedModels(models: OpenRouterModel[], query: string): OpenRouterModel[] {
  if (!query.trim()) return models;
  const fuse = new Fuse(models, {
    ...HOSTED_MODEL_FUSE_OPTIONS,
    keys: [
      { name: 'name', weight: 2 },
      { name: 'id', weight: 1.5 },
      { name: 'provider', weight: 1 },
    ],
  });
  return fuse.search(query).map((result) => result.item);
}

export function buildHostedModelPickerGroups(
  interpreterModels: InterpreterModelOption[],
  openRouterModels: OpenRouterModel[],
): HostedModelPickerGroup[] {
  const groups = new Map<string, HostedModelPickerItem[]>();

  for (const model of filterHostedToolCapableModels(openRouterModels)) {
    const existing = groups.get(model.provider) || [];
    existing.push({
      id: model.id,
      name: model.name,
      secondaryLabel: model.id,
      provider: model.provider,
      description: model.description || '',
    });
    groups.set(model.provider, existing);
  }

  const providerGroups = Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, items]) => ({
      id: provider,
      label: provider,
      items: [...items].sort(compareItems),
    }));

  return [
    {
      id: 'interpreter',
      label: 'Interpreter',
      items: interpreterModels.map((model) => ({
        id: model.id,
        name: model.name,
        secondaryLabel: model.id,
        provider: 'Interpreter',
        description: '',
      })),
    },
    ...providerGroups,
  ];
}

export function filterHostedModelPickerGroups(
  groups: HostedModelPickerGroup[],
  query: string,
): HostedModelPickerGroup[] {
  if (!query.trim()) return groups;

  return groups
    .map((group) => {
      const fuse = new Fuse(group.items, {
        ...HOSTED_MODEL_FUSE_OPTIONS,
        keys: [
          { name: 'name', weight: 2 },
          { name: 'id', weight: 1.5 },
          { name: 'provider', weight: 1 },
          { name: 'description', weight: 0.5 },
        ],
      });
      const results = fuse.search(query);
      return results.length > 0
        ? { ...group, items: results.map((r) => r.item) }
        : null;
    })
    .filter((group): group is HostedModelPickerGroup => group !== null);
}
