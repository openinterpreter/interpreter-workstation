import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { getLocalModelProviderRuntime } from "../../../shared/types/provider";

import {
  buildAppManagedModelProviderId,
  buildProfileFromPreset,
  getCustomPreset,
  getProfile,
} from "@/lib/codex/profiles";
import { inferProfileIdFromEndpoint } from "@/lib/codex/profile-options";

describe("codex profiles", () => {
  test("community interpreter profile has no hosted base URL by default", () => {
    const originalUseLocalApi = process.env.USE_LOCAL_API;
    const originalPythonApiPort = process.env.PYTHON_API_PORT;
    const originalHostedApiBaseUrl = process.env.INTERPRETER_HOSTED_API_BASE_URL;

    delete process.env.USE_LOCAL_API;
    delete process.env.PYTHON_API_PORT;
    delete process.env.INTERPRETER_HOSTED_API_BASE_URL;

    try {
      const profile = getProfile("interpreter");
      assert.equal(profile.providerConfig?.base_url, "");
    } finally {
      if (originalUseLocalApi === undefined) {
        delete process.env.USE_LOCAL_API;
      } else {
        process.env.USE_LOCAL_API = originalUseLocalApi;
      }
      if (originalPythonApiPort === undefined) {
        delete process.env.PYTHON_API_PORT;
      } else {
        process.env.PYTHON_API_PORT = originalPythonApiPort;
      }
      if (originalHostedApiBaseUrl === undefined) {
        delete process.env.INTERPRETER_HOSTED_API_BASE_URL;
      } else {
        process.env.INTERPRETER_HOSTED_API_BASE_URL = originalHostedApiBaseUrl;
      }
    }
  });

  test("interpreter profile uses a compatible local hosted API when enabled", () => {
    const originalUseLocalApi = process.env.USE_LOCAL_API;
    const originalPythonApiPort = process.env.PYTHON_API_PORT;
    const originalHostedApiBaseUrl = process.env.INTERPRETER_HOSTED_API_BASE_URL;

    process.env.USE_LOCAL_API = "true";
    process.env.PYTHON_API_PORT = "19000";
    delete process.env.INTERPRETER_HOSTED_API_BASE_URL;

    try {
      const profile = getProfile("interpreter");
      assert.equal(profile.providerConfig?.base_url, "http://localhost:19000/v0/openrouter");
    } finally {
      if (originalUseLocalApi === undefined) {
        delete process.env.USE_LOCAL_API;
      } else {
        process.env.USE_LOCAL_API = originalUseLocalApi;
      }
      if (originalPythonApiPort === undefined) {
        delete process.env.PYTHON_API_PORT;
      } else {
        process.env.PYTHON_API_PORT = originalPythonApiPort;
      }
      if (originalHostedApiBaseUrl === undefined) {
        delete process.env.INTERPRETER_HOSTED_API_BASE_URL;
      } else {
        process.env.INTERPRETER_HOSTED_API_BASE_URL = originalHostedApiBaseUrl;
      }
    }
  });

  test("interpreter profile uses the explicit hosted API override when configured", () => {
    const originalUseLocalApi = process.env.USE_LOCAL_API;
    const originalPythonApiPort = process.env.PYTHON_API_PORT;
    const originalHostedApiBaseUrl = process.env.INTERPRETER_HOSTED_API_BASE_URL;

    process.env.USE_LOCAL_API = "true";
    process.env.PYTHON_API_PORT = "19000";
    process.env.INTERPRETER_HOSTED_API_BASE_URL = "https://api.example.test/";

    try {
      const profile = getProfile("interpreter");
      assert.equal(profile.providerConfig?.base_url, "https://api.example.test/v0/openrouter");
    } finally {
      if (originalUseLocalApi === undefined) {
        delete process.env.USE_LOCAL_API;
      } else {
        process.env.USE_LOCAL_API = originalUseLocalApi;
      }
      if (originalPythonApiPort === undefined) {
        delete process.env.PYTHON_API_PORT;
      } else {
        process.env.PYTHON_API_PORT = originalPythonApiPort;
      }
      if (originalHostedApiBaseUrl === undefined) {
        delete process.env.INTERPRETER_HOSTED_API_BASE_URL;
      } else {
        process.env.INTERPRETER_HOSTED_API_BASE_URL = originalHostedApiBaseUrl;
      }
    }
  });

  test("includes supported Responses API presets for config-backed API profiles", () => {
    const supportedEndpointPresets = [
      ["xai", "https://api.x.ai/v1"],
      ["fireworks", "https://api.fireworks.ai/inference/v1"],
    ] as const;

    for (const [presetId, baseUrl] of supportedEndpointPresets) {
      const preset = getCustomPreset(presetId);
      assert.ok(preset, `${presetId} preset should exist`);
      assert.equal(preset.defaultBaseUrl, baseUrl);
      assert.equal(preset.wireApi, "responses");
    }
  });

  test("uses OpenAI's recommended speed and cost default for the OpenAI API preset", () => {
    const preset = getCustomPreset("openai-api");
    assert.ok(preset, "openai-api preset should exist");
    assert.equal(preset.defaultModel, "gpt-5.4-nano");
  });

  test("preserves legacy NVIDIA runtime inference without advertising verified Responses support", () => {
    expect(inferProfileIdFromEndpoint("https://integrate.api.nvidia.com/v1")).toBe("nvidia");
    expect(inferProfileIdFromEndpoint("https://integrate.api.nvidia.com/v1/")).toBe("nvidia");
    expect(inferProfileIdFromEndpoint("https://api.x.ai/v1")).toBe("xai");
    expect(inferProfileIdFromEndpoint("https://api.fireworks.ai/inference/v1")).toBe("fireworks");
    expect(inferProfileIdFromEndpoint("https://api.deepseek.com")).toBe("deepseek");
    expect(inferProfileIdFromEndpoint("https://api.deepseek.com/v1")).toBe("deepseek");
  });

  test("infers distinct Ollama Cloud profile for Ollama Cloud endpoint", () => {
    expect(inferProfileIdFromEndpoint("https://ollama.com/v1")).toBe("ollama-cloud");
    expect(inferProfileIdFromEndpoint("https://ollama.com/v1/")).toBe("ollama-cloud");
  });

  test("uses chat wire api for ollama preset", () => {
    const preset = getCustomPreset("ollama");
    assert.ok(preset, "ollama preset should exist");
    assert.equal(preset.wireApi, "chat");

    const profile = buildProfileFromPreset(preset);
    assert.ok(profile.providerConfig, "ollama profile should include provider config");
    assert.equal(profile.providerConfig.wire_api, "chat");
  });

  test("ollama preset still supports an explicit responses wire api override", () => {
    const preset = getCustomPreset("ollama");
    assert.ok(preset, "ollama preset should exist");
    // Chat Completions is the Ollama default...
    assert.equal(preset.wireApi, "chat");

    // ...but Responses stays selectable as an explicit per-profile opt-in.
    const profile = buildProfileFromPreset(preset, { wireApi: "responses" });
    assert.ok(profile.providerConfig, "ollama profile should include provider config");
    assert.equal(profile.providerConfig.wire_api, "responses");
  });

  test("uses responses wire api for custom endpoints", () => {
    const preset = getCustomPreset("custom");
    assert.ok(preset, "custom preset should exist");
    assert.equal(preset.wireApi, "responses");

    const profile = buildProfileFromPreset(preset, {
      baseUrl: "https://llm.example.internal/v1",
      model: "gpt-compatible",
    });
    assert.ok(profile.providerConfig, "custom profile should include provider config");
    assert.equal(profile.providerConfig.wire_api, "responses");
  });

  test("uses chat wire api for DeepSeek preset", () => {
    const preset = getCustomPreset("deepseek");
    assert.ok(preset, "deepseek preset should exist");
    assert.equal(preset.defaultBaseUrl, "https://api.deepseek.com");
    assert.equal(preset.defaultModel, "deepseek-v4-flash");
    assert.equal(preset.wireApi, "chat");

    const profile = buildProfileFromPreset(preset, { apiKey: "sk-deepseek" });
    assert.equal(profile.modelProvider, buildAppManagedModelProviderId("deepseek"));
    assert.equal(profile.providerConfig?.wire_api, "chat");
    assert.equal(profile.providerConfig?.base_url, "https://api.deepseek.com");
  });

  test("uses chat wire api only when explicitly requested for a custom endpoint", () => {
    const preset = getCustomPreset("custom");
    assert.ok(preset, "custom preset should exist");

    const profile = buildProfileFromPreset(preset, {
      baseUrl: "https://llm.example.internal/v1",
      model: "gpt-compatible",
      wireApi: "chat",
    });

    assert.equal(profile.providerConfig?.wire_api, "chat");
  });

  test("sends default lm-studio bearer token when no apiKey override", () => {
    const preset = getCustomPreset("lmstudio");
    assert.ok(preset, "lmstudio preset should exist");
    assert.equal(preset.wireApi, "chat");

    const profile = buildProfileFromPreset(preset);
    assert.ok(profile.providerConfig, "lmstudio profile should include provider config");
    assert.equal(profile.providerConfig.wire_api, "chat");
    assert.equal(profile.providerConfig.experimental_bearer_token, "lm-studio");
    assert.equal(profile.providerConfig.http_headers?.Authorization, "Bearer lm-studio");
  });

  test("user-provided apiKey overrides default lm-studio token", () => {
    const preset = getCustomPreset("lmstudio");
    assert.ok(preset, "lmstudio preset should exist");

    const profile = buildProfileFromPreset(preset, { apiKey: "my-custom-key" });
    assert.ok(profile.providerConfig);
    assert.equal(profile.providerConfig.experimental_bearer_token, "my-custom-key");
    assert.equal(profile.providerConfig.http_headers?.Authorization, "Bearer my-custom-key");
  });

  test("ollama preset does NOT get default bearer token", () => {
    const preset = getCustomPreset("ollama");
    assert.ok(preset, "ollama preset should exist");

    const profile = buildProfileFromPreset(preset);
    assert.ok(profile.providerConfig);
    assert.equal(profile.providerConfig.experimental_bearer_token, undefined);
  });

  test("keeps Ollama Cloud separate from local Ollama provider IDs", () => {
    const preset = getCustomPreset("ollama-cloud");
    assert.ok(preset, "ollama-cloud preset should exist");
    assert.equal(preset.label, "Ollama Cloud");
    assert.equal(preset.defaultBaseUrl, "https://ollama.com/v1");
    assert.equal(preset.requiresApiKey, true);
    assert.equal(preset.wireApi, "responses");

    const profile = buildProfileFromPreset(preset, {
      apiKey: "ollama-cloud-key",
      model: "gpt-oss:20b",
    });
    assert.equal(profile.id, "ollama-cloud");
    assert.equal(profile.label, "Ollama Cloud");
    assert.equal(profile.modelProvider, buildAppManagedModelProviderId("ollama-cloud"));
    assert.equal(profile.providerConfig?.name, "Ollama Cloud");
    assert.equal(profile.providerConfig?.base_url, "https://ollama.com/v1");
    assert.equal(profile.providerConfig?.experimental_bearer_token, "ollama-cloud-key");
    assert.equal(profile.providerConfig?.http_headers?.Authorization, "Bearer ollama-cloud-key");
  });

  describe("local presets always derive config-backed modelProvider IDs", () => {
    test("ollama with default base URL gets a non-reserved modelProvider", () => {
      const preset = getCustomPreset("ollama");
      assert.ok(preset);
      const profile = buildProfileFromPreset(preset);
      assert.notEqual(profile.modelProvider, "ollama");
      assert.equal(getLocalModelProviderRuntime(profile.modelProvider), "ollama");
      assert.ok(profile.providerConfig);
      assert.equal(profile.providerConfig.base_url, preset.defaultBaseUrl);
    });

    test("ollama with custom remote base URL gets a different modelProvider", () => {
      const preset = getCustomPreset("ollama");
      assert.ok(preset);
      const profile = buildProfileFromPreset(preset, {
        baseUrl: "http://192.168.1.100:11434/v1",
      });
      assert.notEqual(profile.modelProvider, "ollama");
      assert.equal(getLocalModelProviderRuntime(profile.modelProvider), "ollama");
      // The base_url in providerConfig must still reflect the custom URL
      assert.ok(profile.providerConfig);
      assert.equal(profile.providerConfig.base_url, "http://192.168.1.100:11434/v1");
    });

    test("lmstudio with custom remote base URL gets a different modelProvider", () => {
      const preset = getCustomPreset("lmstudio");
      assert.ok(preset);
      const profile = buildProfileFromPreset(preset, {
        baseUrl: "http://10.0.0.5:1234/v1",
      });
      assert.notEqual(profile.modelProvider, "lmstudio");
      assert.equal(getLocalModelProviderRuntime(profile.modelProvider), "lmstudio");
      assert.ok(profile.providerConfig);
      assert.equal(profile.providerConfig.base_url, "http://10.0.0.5:1234/v1");
    });

    test("lmstudio with default base URL gets a non-reserved modelProvider", () => {
      const preset = getCustomPreset("lmstudio");
      assert.ok(preset);
      const profile = buildProfileFromPreset(preset);
      assert.notEqual(profile.modelProvider, "lmstudio");
      assert.equal(getLocalModelProviderRuntime(profile.modelProvider), "lmstudio");
      assert.ok(profile.providerConfig);
      assert.equal(profile.providerConfig.base_url, preset.defaultBaseUrl);
    });

    test("non-local preset uses an app-private provider id even with a custom URL", () => {
      const preset = getCustomPreset("openrouter");
      assert.ok(preset);
      const profile = buildProfileFromPreset(preset, {
        baseUrl: "https://my-proxy.example.com/v1",
      });
      assert.equal(profile.modelProvider, buildAppManagedModelProviderId("openrouter"));
    });

    test("derived modelProvider is deterministic for the same base URL", () => {
      const preset = getCustomPreset("ollama");
      assert.ok(preset);
      const url = "http://192.168.1.100:11434/v1";
      const p1 = buildProfileFromPreset(preset, { baseUrl: url });
      const p2 = buildProfileFromPreset(preset, { baseUrl: url });
      assert.equal(p1.modelProvider, p2.modelProvider);
    });

    test("different base URLs produce different modelProvider names", () => {
      const preset = getCustomPreset("ollama");
      assert.ok(preset);
      const p1 = buildProfileFromPreset(preset, { baseUrl: "http://host-a:11434/v1" });
      const p2 = buildProfileFromPreset(preset, { baseUrl: "http://host-b:11434/v1" });
      assert.notEqual(p1.modelProvider, p2.modelProvider);
    });
  });
});
