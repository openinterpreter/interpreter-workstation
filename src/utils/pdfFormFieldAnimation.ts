export function valuesEqual(a: any, b: any): boolean {
  const normalizeEmpty = (value: any) => (value === null || value === undefined ? '' : value);
  const normalizedA = normalizeEmpty(a);
  const normalizedB = normalizeEmpty(b);

  if (typeof normalizedA === 'boolean' || typeof normalizedB === 'boolean') {
    const toBool = (value: any): boolean => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim();
        if (['yes', 'true', 'on', 'checked', '1', 'x'].includes(lower)) return true;
        if (['no', 'false', 'off', 'unchecked', '0', ''].includes(lower)) return false;
        return false;
      }
      if (typeof value === 'number') return value !== 0;
      return !!value;
    };

    return toBool(normalizedA) === toBool(normalizedB);
  }

  if (Array.isArray(normalizedA) && Array.isArray(normalizedB)) {
    if (normalizedA.length !== normalizedB.length) return false;
    const sortedA = [...normalizedA].sort();
    const sortedB = [...normalizedB].sort();
    return sortedA.every((value, index) => String(value) === String(sortedB[index]));
  }

  if (Array.isArray(normalizedA) || Array.isArray(normalizedB)) return false;

  return String(normalizedA).trim() === String(normalizedB).trim();
}

export function tokenizeForTyping(value: string): string[] {
  if (!value) return [];
  const tokens = value.match(/\s*(?:[a-zA-Z]+|[0-9]+|[^\s\w])/g);
  if (!tokens || tokens.length === 0) return [value];

  const consumed = tokens.join('');
  if (consumed.length < value.length) {
    tokens[tokens.length - 1] += value.slice(consumed.length);
  }

  return tokens;
}
