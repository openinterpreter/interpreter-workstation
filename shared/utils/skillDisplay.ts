export function humanizeSkillName(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';

  const deSlugged = normalized.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!deSlugged) return '';

  // Preserve intentional casing when a human-authored title is provided.
  if (/[A-Z]/.test(deSlugged)) {
    return deSlugged;
  }

  return deSlugged
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}
