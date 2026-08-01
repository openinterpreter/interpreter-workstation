import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Search, Check, ChevronDown, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OpenRouterModelCatalogResult, OpenRouterModel } from '../../shared/types/provider';
import {
  HOSTED_MODEL_PICKER_EMPTY_STATE_ID,
  HOSTED_MODEL_PICKER_OPTION_ITEM_ID,
  HOSTED_MODEL_PICKER_POPOVER_ID,
  HOSTED_MODEL_PICKER_REFRESH_BUTTON_ID,
  HOSTED_MODEL_PICKER_SEARCH_INPUT_ID,
  HOSTED_MODEL_PICKER_TRIGGER_ID,
} from '../../shared/element-ids';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './ui/field';
import { InterpreterLogoMark } from './InterpreterLogoMark';
import { HostedProviderIcon } from './icons/HostedProviderIcon';
import { ExpensiveModelBadge } from './ModelSignalBadges';
import { PROVIDER_MODEL_DEFAULTS } from '../../shared/types/modelDefaults';
import {
  filterHostedToolCapableModels,
  fuzzySearchHostedModels,
  shouldSuppressHostedModelInDefaultBrowse,
} from '../utils/hostedOpenRouterPicker';
import { isExpensiveModelId } from '../utils/modelCostSignals';

interface HostedModelPickerProps {
  label: string;
  description?: string;
  modelId?: string;
  catalog: OpenRouterModelCatalogResult | null;
  loading: boolean;
  error?: string | null;
  showRecommendedGrid?: boolean;
  hideInterpreterRecommended?: boolean;
  defaultExpanded?: boolean;
  showBrowseToggle?: boolean;
  onModelChange: (modelId: string, name?: string) => void;
  onRefresh: () => void;
}

interface RecommendedModel {
  id: string;
  name: string;
  subtitle: string;
  iconType: 'interpreter' | 'hosted';
  provider?: string;
}

const RECOMMENDED_MODELS: RecommendedModel[] = [
  { id: PROVIDER_MODEL_DEFAULTS.hosted.main, name: 'Smart', subtitle: 'Best quality', iconType: 'interpreter' },
  { id: PROVIDER_MODEL_DEFAULTS.hosted.fast, name: 'Fast', subtitle: 'Quick responses', iconType: 'interpreter' },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4', subtitle: 'OpenAI', iconType: 'hosted', provider: 'OpenAI' },
  { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4-mini', subtitle: 'OpenAI', iconType: 'hosted', provider: 'OpenAI' },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', subtitle: 'Anthropic', iconType: 'hosted', provider: 'Anthropic' },
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', subtitle: 'Anthropic', iconType: 'hosted', provider: 'Anthropic' },
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', subtitle: 'Google', iconType: 'hosted', provider: 'Google' },
  { id: 'deepseek/deepseek-v3.2-speciale', name: 'DeepSeek V3.2', subtitle: 'DeepSeek', iconType: 'hosted', provider: 'DeepSeek' },
  { id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen 3.5 397B', subtitle: 'Alibaba', iconType: 'hosted', provider: 'Alibaba' },
  { id: 'minimax/minimax-m2.5', name: 'MiniMax M2.5', subtitle: 'MiniMax', iconType: 'hosted', provider: 'MiniMax' },
];

const PICKER_CARD_CLASS = '[background-color:var(--picker-card-bg)] transition-[background-color] duration-150 hover:[background-color:var(--picker-card-hover-bg)]';
const PICKER_CARD_BG = 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 96%, var(--oa-bg-subtle, var(--muted)) 4%)';
const PICKER_CARD_HOVER_BG = 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 20%, var(--oa-bg-app, var(--background)) 80%)';
const PICKER_CARD_SELECTED_BG = 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 24%, var(--oa-bg-app, var(--background)) 76%)';
const PICKER_CARD_SELECTED_HOVER_BG = 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 32%, var(--oa-bg-app, var(--background)) 68%)';

function ModelIcon({ model, size = 20 }: { model: RecommendedModel; size?: number }) {
  switch (model.iconType) {
    case 'interpreter':
      return <InterpreterLogoMark fitSquare size={size} segmentClassName="bg-current" className="text-muted-foreground" />;
    case 'hosted':
      return (
        <HostedProviderIcon
          modelId={model.id}
          provider={model.provider}
          className="size-5 rounded-[4px] object-contain grayscale"
        />
      );
  }
}

export function HostedModelPicker({
  label,
  description,
  modelId,
  catalog,
  loading,
  error = null,
  showRecommendedGrid = true,
  hideInterpreterRecommended = false,
  defaultExpanded = false,
  showBrowseToggle = true,
  onModelChange,
  onRefresh,
}: HostedModelPickerProps) {
  const { t } = useTranslation();
  const [showMore, setShowMore] = useState(defaultExpanded);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(24);
  const deferredQuery = useDeferredValue(query);

  const selectedModelId = modelId || (showRecommendedGrid ? PROVIDER_MODEL_DEFAULTS.hosted.main : '');
  const recommendedModels = useMemo(
    () => RECOMMENDED_MODELS.filter((model) => !(hideInterpreterRecommended && model.iconType === 'interpreter')),
    [hideInterpreterRecommended],
  );

  const catalogModels = useMemo(
    () => filterHostedToolCapableModels(catalog?.models || []),
    [catalog?.models],
  );
  const selectedCatalogModel = useMemo(
    () => catalogModels.find((model) => model.id === selectedModelId) ?? null,
    [catalogModels, selectedModelId],
  );

  const filteredCatalogModels = useMemo(() => {
    if (deferredQuery.trim()) {
      return fuzzySearchHostedModels(catalogModels, deferredQuery).slice(0, visibleCount);
    }
    return catalogModels
      .filter((model) => !shouldSuppressHostedModelInDefaultBrowse(model))
      .slice(0, visibleCount);
  }, [catalogModels, deferredQuery, visibleCount]);

  useEffect(() => {
    setVisibleCount(deferredQuery.trim() ? 24 : 18);
  }, [deferredQuery, showMore]);

  const handleResultsScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const currentTarget = event.currentTarget;
    const remainingScroll = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight;
    if (remainingScroll > 72) return;
    setVisibleCount((previous) => previous + 24);
  }, []);

  // Group filtered models by provider
  const groupedModels = useMemo(() => {
    const groups = new Map<string, OpenRouterModel[]>();
    for (const model of filteredCatalogModels) {
      const existing = groups.get(model.provider) || [];
      existing.push(model);
      groups.set(model.provider, existing);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, models]) => ({ provider, models }));
  }, [filteredCatalogModels]);

  const handleSelect = (id: string, name: string) => {
    onModelChange(id, name);
  };

  return (
    <FieldGroup className="gap-3">
      <Field>
        <FieldLabel>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </Field>

      {showRecommendedGrid && (
        <div className="grid grid-cols-2 gap-2">
          {recommendedModels.map((model) => {
          const isSelected = selectedModelId === model.id;
          return (
            <button
              key={model.id}
              type="button"
              data-testid={isSelected ? HOSTED_MODEL_PICKER_TRIGGER_ID : undefined}
              onClick={() => {
                if (isSelected) {
                  setShowMore((prev) => !prev);
                  return;
                }
                handleSelect(model.id, model.name);
              }}
              className={`group relative flex items-center gap-3 rounded-[var(--control-radius)] px-3 py-2.5 text-left ${PICKER_CARD_CLASS}`}
              style={{
                border: 'var(--border-width) solid var(--border)',
                '--picker-card-bg': isSelected ? PICKER_CARD_SELECTED_BG : PICKER_CARD_BG,
                '--picker-card-hover-bg': isSelected ? PICKER_CARD_SELECTED_HOVER_BG : PICKER_CARD_HOVER_BG,
              }}
            >
              <div className="flex size-8 shrink-0 items-center justify-center">
                <ModelIcon model={model} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2.5 text-ui-sm font-medium text-foreground">
                  <span className="truncate">{model.name}</span>
                  {isExpensiveModelId(model.id) ? <ExpensiveModelBadge /> : null}
                </div>
                <div className="truncate text-ui-xs text-muted-foreground">
                  {model.subtitle}
                </div>
              </div>
              {isSelected && (
                <Check className="size-4 shrink-0 text-foreground" />
              )}
            </button>
          );
          })}
        </div>
      )}

      {!showRecommendedGrid && selectedModelId && (
        <div
          data-testid={HOSTED_MODEL_PICKER_TRIGGER_ID}
          className={`flex items-center gap-3 rounded-[var(--control-radius)] px-3 py-2.5 ${PICKER_CARD_CLASS}`}
          style={{
            border: 'var(--border-width) solid var(--border)',
            '--picker-card-bg': PICKER_CARD_SELECTED_BG,
            '--picker-card-hover-bg': PICKER_CARD_SELECTED_HOVER_BG,
          }}
        >
          <Check className="size-4 shrink-0 text-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-ui-xs text-muted-foreground">Selected model</div>
            <div className="truncate text-ui-sm font-medium text-foreground">
              {selectedCatalogModel?.name || selectedModelId}
            </div>
            <div className="truncate text-ui-xs text-muted-foreground">
              {selectedCatalogModel ? `${selectedCatalogModel.provider} • ${selectedCatalogModel.id}` : selectedModelId}
            </div>
          </div>
        </div>
      )}

      <div>
        {showBrowseToggle && (
          <button
            type="button"
            onClick={() => setShowMore(!showMore)}
            className="flex w-full items-center gap-2 py-1.5 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={`size-4 transition-transform duration-150 ${showMore ? 'rotate-180' : ''}`}
            />
            <span>{showMore ? 'Hide models' : 'More models'}</span>
            {loading && (
              <RefreshCw className="ml-auto size-3.5 animate-spin text-muted-foreground" />
            )}
          </button>
        )}

        {(showMore || !showBrowseToggle) && (
          <div
            data-testid={HOSTED_MODEL_PICKER_POPOVER_ID}
            className={`rounded-[var(--control-radius-lg)] overflow-hidden ${showBrowseToggle ? 'mt-2' : ''}`}
            style={{ border: 'var(--border-width) solid var(--border)' }}
          >
            {/* Search bar */}
            <div className="flex items-center gap-2 border-b p-2" style={{ borderColor: 'var(--border)' }}>
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  role="combobox"
                  placeholder="Search models..."
                  className="h-8 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0"
                  data-testid={HOSTED_MODEL_PICKER_SEARCH_INPUT_ID}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRefresh}
                disabled={loading}
                className="h-7 px-2 text-muted-foreground"
                data-testid={HOSTED_MODEL_PICKER_REFRESH_BUTTON_ID}
              >
                <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            {catalog?.stale && (
              <p className="border-b px-3 py-1.5 text-ui-xs text-muted-foreground" style={{ borderColor: 'var(--border)' }}>
                {t('settings.profiles.provider.hosted.cachedModelsNotice')}
              </p>
            )}

            {/* Model list */}
            <div className="max-h-[280px] overflow-y-auto" onScroll={handleResultsScroll}>
              {groupedModels.length === 0 ? (
                <div
                  data-testid={HOSTED_MODEL_PICKER_EMPTY_STATE_ID}
                  className="px-3 py-6 text-center text-ui-sm text-muted-foreground"
                >
                  {loading
                    ? t('common.loading')
                    : error
                      ? "Couldn't load models. Refresh to retry."
                      : deferredQuery
                        ? t('settings.profiles.provider.hosted.emptyState')
                        : 'No models available'}
                </div>
              ) : (
                groupedModels.map(({ provider, models }) => (
                  <div key={provider}>
                    <div className="sticky top-0 bg-[var(--background)] px-3 py-1.5 text-ui-xs font-medium text-muted-foreground">
                      {provider}
                    </div>
                    {models.map((model) => {
                      const isSelected = selectedModelId === model.id;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          data-testid={HOSTED_MODEL_PICKER_OPTION_ITEM_ID}
                          data-model-id={model.id}
                          onClick={() => handleSelect(model.id, model.name)}
                          className={`flex w-full items-center gap-3 px-3 py-2 text-left ${PICKER_CARD_CLASS}`}
                          style={{
                            '--picker-card-bg': isSelected ? PICKER_CARD_SELECTED_BG : 'transparent',
                            '--picker-card-hover-bg': isSelected ? PICKER_CARD_SELECTED_HOVER_BG : PICKER_CARD_HOVER_BG,
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-ui-sm text-foreground">
                              {model.name}
                            </div>
                            <div className="truncate text-ui-xs text-muted-foreground">
                              {model.id}
                            </div>
                          </div>
                          {isSelected && (
                            <Check className="size-4 shrink-0 text-foreground" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </FieldGroup>
  );
}
