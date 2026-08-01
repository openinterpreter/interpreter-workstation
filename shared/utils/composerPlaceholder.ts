const AGENT_COMPOSER_PLACEHOLDERS = [
  'What are you thinking about?',
  'How can I help?',
] as const;

const agentComposerPlaceholderCache = new Map<string, string>();

export function pickAgentComposerPlaceholder(agentId: string): string {
  const cachedPlaceholder = agentComposerPlaceholderCache.get(agentId);
  if (cachedPlaceholder) {
    return cachedPlaceholder;
  }

  const placeholder = pickRandomComposerPlaceholder();
  agentComposerPlaceholderCache.set(agentId, placeholder);
  return placeholder;
}

export function pickRandomComposerPlaceholder(): string {
  return AGENT_COMPOSER_PLACEHOLDERS[Math.floor(Math.random() * AGENT_COMPOSER_PLACEHOLDERS.length)];
}

export { AGENT_COMPOSER_PLACEHOLDERS };
