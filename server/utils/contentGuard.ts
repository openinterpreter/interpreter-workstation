const INTERNAL_PROMPT_MARKERS: ReadonlyArray<Readonly<{ id: string; pattern: RegExp }>> = [
  { id: 'workstation-context-tag', pattern: /<workstation-context>/i },
  { id: 'agents-instructions-header', pattern: /#\s*AGENTS\.md instructions for/i },
  { id: 'skills-available-section', pattern: /###\s*Available skills/i },
  { id: 'skills-usage-section', pattern: /###\s*How to use skills/i },
  { id: 'internal-instructions-block', pattern: /<INSTRUCTIONS>/i },
];

export function detectInternalPromptArtifacts(content: string): string[] {
  if (!content) return [];
  return INTERNAL_PROMPT_MARKERS.filter(({ pattern }) => pattern.test(content)).map(({ id }) => id);
}

export function rejectIfInternalContext(content: string): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  const artifacts = detectInternalPromptArtifacts(content);
  if (artifacts.length === 0) return null;
  return {
    content: [{
      type: 'text',
      text: 'Error: Refusing to include internal runtime instructions or hidden context. Provide only user-authored content.',
    }],
    isError: true,
  };
}
