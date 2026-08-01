import { describe, expect, test } from 'bun:test';
import { shouldServeBuiltRendererRequest } from './builtRendererRouting';

describe('shouldServeBuiltRendererRequest', () => {
  test('serves frontend assets and client-side routes', () => {
    expect(shouldServeBuiltRendererRequest('GET', '/')).toBe(true);
    expect(shouldServeBuiltRendererRequest('GET', '/settings/tools')).toBe(true);
    expect(shouldServeBuiltRendererRequest('GET', '/assets/index.js')).toBe(true);
  });

  test('does not intercept backend routes', () => {
    expect(shouldServeBuiltRendererRequest('GET', '/api/servers')).toBe(false);
    expect(shouldServeBuiltRendererRequest('GET', '/v1/models')).toBe(false);
    expect(shouldServeBuiltRendererRequest('GET', '/mcp')).toBe(false);
    expect(shouldServeBuiltRendererRequest('GET', '/mcp/session')).toBe(false);
  });

  test('does not intercept non-get requests', () => {
    expect(shouldServeBuiltRendererRequest('POST', '/settings/tools')).toBe(false);
  });

  test('uses exact route boundaries for backend prefixes', () => {
    expect(shouldServeBuiltRendererRequest('GET', '/apis')).toBe(true);
  });
});
