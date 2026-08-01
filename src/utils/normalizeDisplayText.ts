export function normalizeDisplayText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.message || value.name || String(value);
  }

  if (value === null || value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
