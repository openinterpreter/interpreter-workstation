export type UserVisibleErrorKind = 'toast' | 'chat' | 'settings';

function formatLogValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function buildUserVisibleErrorLogLine(
  kind: UserVisibleErrorKind,
  fields: Record<string, unknown>,
): string {
  const serializedFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`);

  return ['[UI_ERROR]', `kind=${kind}`, ...serializedFields].join(' ');
}

export function logUserVisibleError(
  kind: UserVisibleErrorKind,
  fields: Record<string, unknown>,
): void {
  console.error(buildUserVisibleErrorLogLine(kind, fields));
}
