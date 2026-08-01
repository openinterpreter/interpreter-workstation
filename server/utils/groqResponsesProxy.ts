import type { Profile as CodexProfile } from '../../src/lib/codex/profiles';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Groq's Responses implementation rejects several OpenAI-specific fields.
// Keep a single canonical sanitization pass here so app runtime and tests use
// identical request shaping.
export function sanitizeGroqResponsesRequest(body: unknown): unknown {
  if (!isJsonObject(body)) {
    return body;
  }

  const next: JsonObject = { ...body };

  // Unsupported on Groq Responses.
  delete next.client_metadata;
  delete next.include;
  delete next.prompt_cache_key;
  delete next.service_tier;

  // Remove reasoning envelope entirely; Groq rejects the OpenAI shape.
  delete next.reasoning;

  if (Array.isArray(next.tools)) {
    const functionTools = next.tools.filter((tool) => {
      return isJsonObject(tool) && tool.type === "function";
    });
    if (functionTools.length > 0) {
      next.tools = functionTools;
    } else {
      delete next.tools;
    }
  }

  return next;
}

export function buildGroqProxyBaseUrl(port: number): string {
  return `http://localhost:${port}/api/agent/groq-proxy`;
}

export function routeGroqProfileThroughProxy(
  profile: CodexProfile,
  proxyBaseUrl: string,
): CodexProfile {
  const currentBaseUrl = profile.providerConfig?.base_url;
  if (!profile.providerConfig || currentBaseUrl === proxyBaseUrl) {
    return profile;
  }

  if (profile.modelProvider !== 'groq') {
    return profile;
  }

  return {
    ...profile,
    providerConfig: {
      ...profile.providerConfig,
      base_url: proxyBaseUrl,
    },
  };
}
