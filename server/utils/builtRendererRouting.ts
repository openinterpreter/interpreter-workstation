const BUILT_RENDERER_BYPASS_PREFIXES = [
  '/api',
  '/v1',
  '/mcp',
] as const;

function matchesRoutePrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function shouldServeBuiltRendererRequest(method: string, pathname: string): boolean {
  if (method !== 'GET') {
    return false;
  }

  return !BUILT_RENDERER_BYPASS_PREFIXES.some((prefix) => matchesRoutePrefix(pathname, prefix));
}
