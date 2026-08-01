import { OPENROUTER_MODEL_OPTIONS } from '../../shared/generated/modelCatalog';
import type { OpenRouterModelCatalogResult } from '../../shared/types/provider';

export const GENERATED_OPENROUTER_CATALOG: OpenRouterModelCatalogResult = {
  models: OPENROUTER_MODEL_OPTIONS.map((option) => ({
    id: option.id,
    name: option.name,
    provider: option.id.split('/')[0] || 'openrouter',
  })),
  fetchedAt: 0,
  stale: false,
};
