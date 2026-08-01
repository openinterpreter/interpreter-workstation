import { describe, expect, test } from 'bun:test';
import {
  buildHostedModelPickerGroups,
  filterHostedToolCapableModels,
  filterHostedModelPickerGroups,
  fuzzySearchHostedModels,
  interpreterModelsToOpenRouterModels,
} from './hostedOpenRouterPicker';

const interpreterModels = [
  { id: 'interpreter-smart', name: 'Interpreter Smart' },
  { id: 'interpreter-fast', name: 'Interpreter Fast' },
];

const openRouterModels = [
  {
    id: 'openai/gpt-5.4',
    name: 'GPT-5.4',
    provider: 'openai',
    description: 'Flagship reasoning model',
    contextLength: 400_000,
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o-mini',
    provider: 'openai',
    description: 'Legacy small OpenAI model',
    contextLength: 128_000,
  },
  {
    id: 'openai/gpt-4.1',
    name: 'GPT-4.1',
    provider: 'openai',
    description: 'Legacy OpenAI model',
    contextLength: 1_000_000,
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    description: 'General purpose frontier model',
    contextLength: 200_000,
  },
  {
    id: 'anthropic/claude-opus-4.7',
    name: 'Claude Opus 4.7',
    provider: 'anthropic',
    description: 'Frontier reasoning model',
    contextLength: 200_000,
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    description: 'Fast lightweight model',
    contextLength: 200_000,
  },
];

describe('buildHostedModelPickerGroups', () => {
  test('pins Interpreter first and sorts provider groups alphabetically', () => {
    expect(buildHostedModelPickerGroups(interpreterModels, openRouterModels)).toEqual([
      {
        id: 'interpreter',
        label: 'Interpreter',
        items: [
          {
            id: 'interpreter-smart',
            name: 'Interpreter Smart',
            secondaryLabel: 'interpreter-smart',
            provider: 'Interpreter',
            description: '',
          },
          {
            id: 'interpreter-fast',
            name: 'Interpreter Fast',
            secondaryLabel: 'interpreter-fast',
            provider: 'Interpreter',
            description: '',
          },
        ],
      },
      {
        id: 'anthropic',
        label: 'anthropic',
        items: [
          {
            id: 'anthropic/claude-haiku-4.5',
            name: 'Claude Haiku 4.5',
            secondaryLabel: 'anthropic/claude-haiku-4.5',
            provider: 'anthropic',
            description: 'Fast lightweight model',
          },
          {
            id: 'anthropic/claude-opus-4.7',
            name: 'Claude Opus 4.7',
            secondaryLabel: 'anthropic/claude-opus-4.7',
            provider: 'anthropic',
            description: 'Frontier reasoning model',
          },
          {
            id: 'anthropic/claude-sonnet-4.6',
            name: 'Claude Sonnet 4.6',
            secondaryLabel: 'anthropic/claude-sonnet-4.6',
            provider: 'anthropic',
            description: 'General purpose frontier model',
          },
        ],
      },
      {
        id: 'openai',
        label: 'openai',
        items: [
          {
            id: 'openai/gpt-5.4',
            name: 'GPT-5.4',
            secondaryLabel: 'openai/gpt-5.4',
            provider: 'openai',
            description: 'Flagship reasoning model',
          },
        ],
      },
    ]);
  });

  test('omits OpenAI hosted models that cannot use custom/freeform tools', () => {
    const groups = buildHostedModelPickerGroups(interpreterModels, openRouterModels);
    const allIds = groups.flatMap((group) => group.items.map((item) => item.id));
    expect(allIds).toContain('openai/gpt-5.4');
    expect(allIds).not.toContain('openai/gpt-4o-mini');
    expect(allIds).not.toContain('openai/gpt-4.1');
  });
});

describe('filterHostedToolCapableModels', () => {
  test('keeps non-OpenAI models and GPT-5 OpenAI models only', () => {
    const results = filterHostedToolCapableModels(openRouterModels);
    const ids = results.map((model) => model.id);
    expect(ids).toContain('openai/gpt-5.4');
    expect(ids).toContain('anthropic/claude-sonnet-4.6');
    expect(ids).not.toContain('openai/gpt-4o-mini');
    expect(ids).not.toContain('openai/gpt-4.1');
  });
});

describe('fuzzySearchHostedModels', () => {
  test('matches model names when users type spaces instead of separators', () => {
    const models = [
      { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4-mini', provider: 'openai' },
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
      { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', provider: 'anthropic' },
    ];
    const results = fuzzySearchHostedModels(models, 'gpt 5.4 mini');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('openai/gpt-5.4-mini');
  });

  test('matches Claude Opus 4.7 when users type natural language', () => {
    const models = [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
      { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', provider: 'anthropic' },
    ];
    const results = fuzzySearchHostedModels(models, 'claude opus 4.7');
    expect(results[0].id).toBe('anthropic/claude-opus-4.7');
  });

  test('does not match unrelated terms', () => {
    const models = [
      { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4-mini', provider: 'openai' },
    ];
    expect(fuzzySearchHostedModels(models, 'claude opus')).toEqual([]);
  });

  test('returns all models for empty query', () => {
    const models = [
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', provider: 'openai' },
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
    ];
    expect(fuzzySearchHostedModels(models, '')).toEqual(models);
  });
});

describe('filterHostedModelPickerGroups', () => {
  const groups = buildHostedModelPickerGroups(interpreterModels, openRouterModels);

  test('matches description text while preserving group structure', () => {
    const results = filterHostedModelPickerGroups(groups, 'lightweight');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('anthropic');
    expect(results[0].items).toHaveLength(1);
    expect(results[0].items[0].id).toBe('anthropic/claude-haiku-4.5');
  });

  test('matches model name and returns all matches within a group', () => {
    const results = filterHostedModelPickerGroups(groups, 'claude');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('anthropic');
    expect(results[0].items).toHaveLength(3);
    const ids = results[0].items.map((item) => item.id);
    expect(ids).toContain('anthropic/claude-haiku-4.5');
    expect(ids).toContain('anthropic/claude-opus-4.7');
    expect(ids).toContain('anthropic/claude-sonnet-4.6');
  });

  test('matches model names when users type spaces instead of separators', () => {
    const grouped = buildHostedModelPickerGroups(interpreterModels, [
      ...openRouterModels,
      {
        id: 'openai/gpt-5.4-mini',
        name: 'GPT-5.4-mini',
        provider: 'openai',
        description: 'Fast model',
        contextLength: 400_000,
      },
    ]);

    const results = filterHostedModelPickerGroups(grouped, 'gpt 5.4 mini');
    const allItems = results.flatMap((g) => g.items);
    expect(allItems.some((item) => item.id === 'openai/gpt-5.4-mini')).toBe(true);
  });
});

describe('interpreterModelsToOpenRouterModels', () => {
  test('derives provider from the slug prefix and carries reasoning metadata', () => {
    expect(
      interpreterModelsToOpenRouterModels([
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          isDefault: true,
          supportedReasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
        },
        { id: 'openai/gpt-5.4', name: 'GPT-5.4', isDefault: false },
      ]),
    ).toEqual([
      {
        id: 'anthropic/claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6',
        provider: 'anthropic',
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
      },
      {
        id: 'openai/gpt-5.4',
        name: 'GPT-5.4',
        provider: 'openai',
        supportedReasoningEfforts: undefined,
        defaultReasoningEffort: undefined,
      },
    ]);
  });

  test('uses the whole id as provider for flat ids and falls back to the id for empty names', () => {
    const [model] = interpreterModelsToOpenRouterModels([
      { id: 'some-flat-id', name: '', isDefault: false },
    ]);
    expect(model.provider).toBe('some-flat-id');
    expect(model.name).toBe('some-flat-id');
  });

  test('falls back to the openrouter provider only when the slug prefix is empty', () => {
    const [model] = interpreterModelsToOpenRouterModels([
      { id: '/leading-slash', name: 'Leading slash', isDefault: false },
    ]);
    expect(model.provider).toBe('openrouter');
  });

  test('dedupes by id and drops empty ids', () => {
    const result = interpreterModelsToOpenRouterModels([
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', isDefault: false },
      { id: 'openai/gpt-5.4', name: 'duplicate', isDefault: false },
      { id: '  ', name: 'blank', isDefault: false },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('GPT-5.4');
  });

  test('drops runtime alias slugs (~) so the picker has no duplicate ~provider group', () => {
    const result = interpreterModelsToOpenRouterModels([
      { id: '~anthropic/claude-sonnet-latest', name: 'Anthropic Claude Sonnet Latest', isDefault: false },
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', isDefault: false },
      { id: '~openai/gpt-latest', name: 'OpenAI GPT Latest', isDefault: false },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', isDefault: false },
    ]);
    expect(result.map((model) => model.id)).toEqual([
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.4',
    ]);
    expect(result.every((model) => !model.provider.startsWith('~'))).toBe(true);
  });
});
