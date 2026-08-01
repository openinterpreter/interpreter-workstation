export interface TrustedAppRendererUrlOptions {
  devRendererPortStart: number;
  devRendererPortEnd: number;
}

export function isTrustedAppRendererUrl(
  value: string,
  options: TrustedAppRendererUrlOptions,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol === 'file:') {
    return parsed.hostname === '' || parsed.hostname === 'localhost';
  }

  if (parsed.protocol !== 'http:') {
    return false;
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }

  if (parsed.hostname !== 'localhost') {
    return false;
  }

  const port = Number(parsed.port);
  if (!Number.isInteger(port)) {
    return false;
  }

  return port >= options.devRendererPortStart && port <= options.devRendererPortEnd;
}
