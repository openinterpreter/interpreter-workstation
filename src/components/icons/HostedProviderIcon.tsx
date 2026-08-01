import type { ComponentType } from 'react';
import { AnthropicIcon, GoogleIcon, GroqIcon, OpenAIIcon } from './BrandIcons';

interface HostedProviderIconProps {
  modelId?: string;
  provider?: string;
  className?: string;
}

const HOSTED_PROVIDER_ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  openai: OpenAIIcon,
  anthropic: AnthropicIcon,
  google: GoogleIcon,
  googleaistudio: GoogleIcon,
  gemini: GoogleIcon,
  groq: GroqIcon,
};

function normalizeProviderKey(value?: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getHostedProviderIcon(modelId?: string, provider?: string): ComponentType<{ className?: string }> | null {
  const family = normalizeProviderKey(modelId?.split('/')[0]);
  if (family && HOSTED_PROVIDER_ICON_MAP[family]) {
    return HOSTED_PROVIDER_ICON_MAP[family];
  }

  const normalizedProvider = normalizeProviderKey(provider);
  if (normalizedProvider && HOSTED_PROVIDER_ICON_MAP[normalizedProvider]) {
    return HOSTED_PROVIDER_ICON_MAP[normalizedProvider];
  }

  return null;
}

function getFallbackLetter(modelId?: string, provider?: string): string {
  const source = provider || modelId?.split('/')[0] || modelId || '?';
  return source.charAt(0).toUpperCase();
}

export function HostedProviderIcon({
  modelId,
  provider,
  className,
}: HostedProviderIconProps) {
  const Icon = getHostedProviderIcon(modelId, provider);

  if (!Icon) {
    return (
      <span className={`flex items-center justify-center text-[11px] font-semibold text-[var(--oa-text-muted)] ${className || ''}`}>
        {getFallbackLetter(modelId, provider)}
      </span>
    );
  }

  return <Icon className={className} />;
}
