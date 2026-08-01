import { describe, expect, test } from "bun:test";

import { type Profile as CodexProfile } from "../../src/lib/codex/profiles";
import {
  buildGroqProxyBaseUrl,
  routeGroqProfileThroughProxy,
  sanitizeGroqResponsesRequest,
} from "./groqResponsesProxy";

describe("sanitizeGroqResponsesRequest", () => {
  test("removes unsupported Groq Responses fields and tool types", () => {
    expect(
      sanitizeGroqResponsesRequest({
        client_metadata: { origin: "interpreter" },
        include: ["reasoning.encrypted_content"],
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        instructions: "test",
        model: "openai/gpt-oss-120b",
        parallel_tool_calls: true,
        prompt_cache_key: "cache-key",
        reasoning: {
          effort: "xhigh",
          summary: "detailed",
        },
        service_tier: "priority",
        store: false,
        stream: true,
        tool_choice: "auto",
        tools: [
          { type: "function", name: "list_files", parameters: { type: "object" } },
          { type: "custom", name: "apply_patch" },
          { type: "web_search" },
        ],
      }),
    ).toEqual({
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      instructions: "test",
      model: "openai/gpt-oss-120b",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      tool_choice: "auto",
      tools: [
        { type: "function", name: "list_files", parameters: { type: "object" } },
      ],
    });
  });

  test("drops tools entirely when no function tools remain", () => {
    expect(
      sanitizeGroqResponsesRequest({
        model: "openai/gpt-oss-120b",
        tools: [{ type: "custom", name: "apply_patch" }],
      }),
    ).toEqual({
      model: "openai/gpt-oss-120b",
    });
  });

  test("returns non-object values unchanged", () => {
    expect(sanitizeGroqResponsesRequest(null)).toBeNull();
    expect(sanitizeGroqResponsesRequest("raw")).toBe("raw");
  });
});

describe("routeGroqProfileThroughProxy", () => {
  const proxyBaseUrl = buildGroqProxyBaseUrl(5177);

  test("routes official Groq profiles through the local proxy", () => {
    const profile: CodexProfile = {
      id: "groq",
      label: "Groq",
      modelProvider: "groq",
      model: "openai/gpt-oss-120b",
      providerConfig: {
        base_url: "https://api.groq.com/openai/v1",
        name: "Groq",
        requires_openai_auth: false,
        wire_api: "responses",
      },
    };

    expect(routeGroqProfileThroughProxy(profile, proxyBaseUrl)).toEqual({
      ...profile,
      providerConfig: {
        ...profile.providerConfig,
        base_url: proxyBaseUrl,
      },
    });
  });

  test("does not route non-Groq profiles just because their base URL points at Groq", () => {
    const profile: CodexProfile = {
      id: "custom",
      label: "Custom Endpoint",
      modelProvider: "custom",
      model: "openai/gpt-oss-120b",
      providerConfig: {
        base_url: "https://api.groq.com/openai/v1",
        name: "Custom Endpoint",
        requires_openai_auth: false,
        wire_api: "responses",
      },
    };

    expect(routeGroqProfileThroughProxy(profile, proxyBaseUrl)).toEqual(profile);
  });

  test("leaves non-Groq profiles unchanged", () => {
    const profile: CodexProfile = {
      id: "custom",
      label: "Custom Endpoint",
      modelProvider: "custom",
      model: "deepseek-chat",
      providerConfig: {
        base_url: "https://api.deepseek.com/v1",
        name: "Custom Endpoint",
        requires_openai_auth: false,
        wire_api: "responses",
      },
    };

    expect(routeGroqProfileThroughProxy(profile, proxyBaseUrl)).toEqual(profile);
  });
});
