export interface UsageIconIdentity {
  type: 'interpreter' | 'hosted';
  modelId?: string;
  provider?: string;
}

const PRO_PLAN_NAME = 'Workstation Pro';
const BUSINESS_PLAN_NAME = 'Workstation Business';
const FREE_PLAN_NAME = 'Free';

const PROVIDER_ACCENT_COLORS: Record<string, string> = {
  openai: '#10A37F',
  anthropic: '#D4A373',
  google: '#4285F4',
  gemini: '#4285F4',
  qwen: '#2AA198',
  alibaba: '#2AA198',
  deepseek: '#4F7AD9',
  minimax: '#C06C84',
  xai: '#6B7280',
  grok: '#6B7280',
  mistral: '#F28C38',
  meta: '#4C6FFF',
  assemblyai: '#8A7EA8',
  cerebras: '#67B95B',
  cohere: '#5B6EE1',
  perplexity: '#4F9A94',
  moonshot: '#C7925B',
  amazon: '#FF9900',
  microsoft: '#5B8DEF',
  together: '#8A6FD1',
  fireworks: '#D9735E',
  nvidia: '#76B900',
};

function normalizeUsageLabel(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeProviderKey(value?: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function resolveUsageIconIdentity(label: string): UsageIconIdentity {
  const normalized = normalizeUsageLabel(label);

  if (
    normalized === PRO_PLAN_NAME.toLowerCase()
    || normalized === BUSINESS_PLAN_NAME.toLowerCase()
    || normalized === FREE_PLAN_NAME.toLowerCase()
    || normalized.startsWith('interpreter')
  ) {
    return { type: 'interpreter' };
  }

  if (normalized.includes('/')) {
    const [provider] = normalized.split('/');
    return {
      type: 'hosted',
      modelId: normalized,
      provider,
    };
  }

  if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) {
    return {
      type: 'hosted',
      modelId: `openai/${normalized}`,
      provider: 'OpenAI',
    };
  }

  if (normalized.includes('claude')) {
    return {
      type: 'hosted',
      modelId: `anthropic/${normalized}`,
      provider: 'Anthropic',
    };
  }

  if (normalized.includes('gemini')) {
    return {
      type: 'hosted',
      modelId: `google/${normalized}`,
      provider: 'Google',
    };
  }

  if (normalized.includes('qwen')) {
    return {
      type: 'hosted',
      modelId: `qwen/${normalized}`,
      provider: 'Alibaba',
    };
  }

  if (normalized.includes('deepseek')) {
    return {
      type: 'hosted',
      modelId: `deepseek/${normalized}`,
      provider: 'DeepSeek',
    };
  }

  if (normalized.includes('minimax')) {
    return {
      type: 'hosted',
      modelId: `minimax/${normalized}`,
      provider: 'MiniMax',
    };
  }

  if (normalized.includes('grok')) {
    return {
      type: 'hosted',
      modelId: `xai/${normalized}`,
      provider: 'xAI',
    };
  }

  if (normalized.includes('mistral')) {
    return {
      type: 'hosted',
      modelId: `mistral/${normalized}`,
      provider: 'Mistral',
    };
  }

  if (normalized.includes('llama')) {
    return {
      type: 'hosted',
      modelId: `meta/${normalized}`,
      provider: 'Meta',
    };
  }

  if (normalized.includes('assemblyai')) {
    return {
      type: 'hosted',
      modelId: normalized,
      provider: 'AssemblyAI',
    };
  }

  if (normalized.includes('cerebras')) {
    return {
      type: 'hosted',
      modelId: normalized,
      provider: 'Cerebras',
    };
  }

  return {
    type: 'hosted',
    provider: label,
  };
}

export function getUsageAccentColor(label: string): string {
  const identity = resolveUsageIconIdentity(label);
  if (identity.type === 'interpreter') {
    return 'var(--foreground)';
  }

  const key = normalizeProviderKey(identity.provider || identity.modelId?.split('/')[0] || label);
  const baseColor = PROVIDER_ACCENT_COLORS[key];

  if (!baseColor) {
    return 'color-mix(in srgb, var(--foreground) 42%, var(--oa-bg-app, var(--background)) 58%)';
  }

  return `color-mix(in srgb, ${baseColor} 62%, var(--oa-bg-app, var(--background)) 38%)`;
}
