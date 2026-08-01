import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildLmStudioManagementUrl,
  buildLmStudioInferenceUrl,
  formatLocalModelToolUseError,
  getGitHubMcpAuthSetupErrorMessage,
  getLmStudioStatus,
  getOllamaStatus,
  isLmStudioModelUsableForChat,
  isLikelyEmbeddingModelId,
  inferLocalRuntimeFromBaseUrl,
  resolveLocalModelToolUseSupport,
} from "./providers";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getGitHubMcpAuthSetupErrorMessage", () => {
  test("explains how to configure GitHub MCP auth when GitHub CLI is missing", () => {
    assert.equal(
      getGitHubMcpAuthSetupErrorMessage(false),
      'GitHub CLI is not installed or not authenticated. Run "gh auth login" in a terminal, or set GH_TOKEN/GITHUB_TOKEN before starting Interpreter.',
    );
  });

  test("explains how to configure GitHub MCP auth when GitHub CLI is signed out", () => {
    assert.equal(
      getGitHubMcpAuthSetupErrorMessage(true),
      'GitHub CLI is installed but not authenticated. Run "gh auth login" in a terminal, or set GH_TOKEN/GITHUB_TOKEN before starting Interpreter.',
    );
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// buildLmStudioManagementUrl
// ---------------------------------------------------------------------------

describe("buildLmStudioManagementUrl", () => {
  test("should_return_default_models_url_when_no_base_url", () => {
    const result = buildLmStudioManagementUrl(undefined, "/api/v1/models");
    assert.equal(result, "http://localhost:1234/api/v1/models");
  });

  test("should_return_default_download_url_when_no_base_url", () => {
    const result = buildLmStudioManagementUrl(undefined, "/api/v1/models/download");
    assert.equal(result, "http://localhost:1234/api/v1/models/download");
  });

  test("should_strip_v1_suffix_before_appending_endpoint", () => {
    const result = buildLmStudioManagementUrl("http://localhost:1234/v1", "/api/v1/models");
    assert.equal(result, "http://localhost:1234/api/v1/models");
  });

  test("should_handle_trailing_slash_on_base_url", () => {
    const result = buildLmStudioManagementUrl("http://localhost:1234/v1/", "/api/v1/models");
    assert.equal(result, "http://localhost:1234/api/v1/models");
  });

  test("should_handle_custom_port", () => {
    const result = buildLmStudioManagementUrl("http://myhost:9999/v1", "/api/v1/models");
    assert.equal(result, "http://myhost:9999/api/v1/models");
  });

  test("should_handle_bare_host_without_v1", () => {
    const result = buildLmStudioManagementUrl("http://localhost:1234", "/api/v1/models");
    assert.equal(result, "http://localhost:1234/api/v1/models");
  });

  test("should_fallback_to_default_on_invalid_url", () => {
    const result = buildLmStudioManagementUrl("not-a-url", "/api/v1/models");
    assert.equal(result, "http://localhost:1234/api/v1/models");
  });

  test("should_handle_empty_string_base_url", () => {
    const result = buildLmStudioManagementUrl("", "/api/v1/models");
    assert.equal(result, "http://localhost:1234/api/v1/models");
  });

  test("should_handle_whitespace_only_base_url", () => {
    const result = buildLmStudioManagementUrl("   ", "/api/v1/models");
    assert.equal(result, "http://localhost:1234/api/v1/models");
  });
});

// ---------------------------------------------------------------------------
// buildLmStudioInferenceUrl
// ---------------------------------------------------------------------------

describe("buildLmStudioInferenceUrl", () => {
  test("should_return_default_inference_url_when_no_base_url", () => {
    const result = buildLmStudioInferenceUrl(undefined);
    assert.equal(result, "http://localhost:1234/v1/models");
  });

  test("should_return_default_inference_url_for_empty_string", () => {
    const result = buildLmStudioInferenceUrl("");
    assert.equal(result, "http://localhost:1234/v1/models");
  });

  test("should_append_models_to_v1_base_url", () => {
    const result = buildLmStudioInferenceUrl("http://localhost:1234/v1");
    assert.equal(result, "http://localhost:1234/v1/models");
  });

  test("should_handle_trailing_slash_on_base_url", () => {
    const result = buildLmStudioInferenceUrl("http://localhost:1234/v1/");
    assert.equal(result, "http://localhost:1234/v1/models");
  });

  test("should_handle_custom_port", () => {
    const result = buildLmStudioInferenceUrl("http://myhost:9999/v1");
    assert.equal(result, "http://myhost:9999/v1/models");
  });

  test("should_add_v1_for_bare_host", () => {
    const result = buildLmStudioInferenceUrl("http://localhost:1234");
    assert.equal(result, "http://localhost:1234/v1/models");
  });

  test("should_fallback_to_default_on_invalid_url", () => {
    const result = buildLmStudioInferenceUrl("not-a-url");
    assert.equal(result, "http://localhost:1234/v1/models");
  });

  test("should_handle_whitespace_only_base_url", () => {
    const result = buildLmStudioInferenceUrl("   ");
    assert.equal(result, "http://localhost:1234/v1/models");
  });
});

// ---------------------------------------------------------------------------
// getLmStudioStatus
// ---------------------------------------------------------------------------

describe("getLmStudioStatus", () => {
  test("marks LM Studio as running when inference endpoint is reachable but management endpoint fails", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/models")) {
        return jsonResponse({ error: "not found" }, 404);
      }
      if (url.includes("/v1/models")) {
        return jsonResponse({
          data: [
            { id: "qwen/qwen3.5-0.8b" },
          ],
        });
      }
      return jsonResponse({ error: "unexpected url" }, 500);
    };

    const status = await getLmStudioStatus("http://localhost:1234/v1");
    assert.equal(status.running, true);
    assert.equal(status.inferenceAvailable, true);
    assert.equal(status.totalChatModels, 1);
    assert.deepEqual(status.lmStudioModels?.map((model) => model.id), ["qwen/qwen3.5-0.8b"]);
    assert.deepEqual(status.models, []);
    assert.equal(status.lmStudioModels?.[0]?.toolUseSupport, "unknown");
  });

  test("merges model metadata from management API with model list from inference API", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/models")) {
        return jsonResponse({
          data: [
            {
              key: "qwen/qwen3.5-4b",
              display_name: "Qwen 3.5 4B",
              params_string: "4B",
              capabilities: { trained_for_tool_use: true },
            },
          ],
        });
      }
      if (url.includes("/v1/models")) {
        return jsonResponse({
          data: [
            { id: "qwen/qwen3.5-4b" },
            { id: "meta/llama-3.2-3b" },
          ],
        });
      }
      return jsonResponse({ error: "unexpected url" }, 500);
    };

    const status = await getLmStudioStatus("http://localhost:1234/v1");
    assert.equal(status.running, true);
    assert.equal(status.inferenceAvailable, true);
    assert.equal(status.totalChatModels, 2);
    assert.deepEqual(status.models, ["qwen/qwen3.5-4b"]);
    assert.deepEqual(
      status.lmStudioModels?.map((model) => ({
        id: model.id,
        toolUseSupport: model.toolUseSupport,
      })),
      [
        { id: "qwen/qwen3.5-4b", toolUseSupport: "supported" },
        { id: "meta/llama-3.2-3b", toolUseSupport: "unknown" },
      ],
    );
  });

  test("merges management metadata onto inference model IDs with the same normalized key", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/models")) {
        return jsonResponse({
          data: [
            {
              key: "unsloth/qwen3.5-4b",
              display_name: "Qwen 3.5 4B",
              params_string: "4B",
              capabilities: { trained_for_tool_use: true },
            },
          ],
        });
      }
      if (url.includes("/v1/models")) {
        return jsonResponse({
          data: [
            { id: "qwen/qwen3.5-4b" },
          ],
        });
      }
      return jsonResponse({ error: "unexpected url" }, 500);
    };

    const status = await getLmStudioStatus("http://localhost:1234/v1");
    assert.deepEqual(status.models, ["qwen/qwen3.5-4b"]);
    assert.deepEqual(status.lmStudioModels, [
      {
        id: "qwen/qwen3.5-4b",
        displayName: "Qwen 3.5 4B",
        paramsString: "4B",
        toolUseSupport: "supported",
      },
    ]);
  });

  test("returns not running when both LM Studio endpoints are unreachable", async () => {
    globalThis.fetch = async () => jsonResponse({ error: "down" }, 503);

    const status = await getLmStudioStatus("http://localhost:1234/v1");
    assert.equal(status.running, false);
    assert.ok(status.error?.includes("management: HTTP 503"));
    assert.ok(status.error?.includes("inference: HTTP 503"));
  });
});

// ---------------------------------------------------------------------------
// getOllamaStatus
// ---------------------------------------------------------------------------

describe("getOllamaStatus", () => {
  test("should_probe_ollama_show_with_model_and_name_fields", async () => {
    const showBodies: unknown[] = [];

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return jsonResponse({
          models: [
            {
              name: "qwen2.5-coder:14b",
              digest: "sha256:issue1282",
              details: { parameter_size: "14B" },
            },
          ],
        });
      }
      if (url.includes("/api/show")) {
        showBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ capabilities: ["completion", "tools"] });
      }
      return jsonResponse({ error: "unexpected url" }, 500);
    };

    const status = await getOllamaStatus("http://localhost:11434/v1");

    assert.deepEqual(showBodies, [
      { model: "qwen2.5-coder:14b" },
      { name: "qwen2.5-coder:14b" },
    ]);
    assert.equal(status.running, true);
    assert.deepEqual(status.models, ["qwen2.5-coder:14b"]);
    assert.deepEqual(status.ollamaModels?.map((model) => ({
      id: model.id,
      toolUseSupport: model.toolUseSupport,
    })), [
      { id: "qwen2.5-coder:14b", toolUseSupport: "supported" },
    ]);
  });

  test("should_use_positive_ollama_show_response_from_name_field", async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return jsonResponse({
          models: [
            {
              name: "legacy-tool-model:latest",
              digest: "sha256:legacy-tool-model",
              details: { parameter_size: "7B" },
            },
          ],
        });
      }
      if (url.includes("/api/show")) {
        const body = JSON.parse(String(init?.body)) as { model?: string; name?: string };
        if (body.name === "legacy-tool-model:latest") {
          return jsonResponse({ capabilities: ["completion", "tools"] });
        }
        return jsonResponse({ error: "model field unsupported" }, 400);
      }
      return jsonResponse({ error: "unexpected url" }, 500);
    };

    const status = await getOllamaStatus("http://localhost:11434/v1");

    assert.equal(status.running, true);
    assert.deepEqual(status.models, ["legacy-tool-model:latest"]);
    assert.equal(status.ollamaModels?.[0]?.toolUseSupport, "supported");
  });

  test("should_prefer_tool_capable_ollama_show_response", async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return jsonResponse({
          models: [
            {
              name: "qwen2.5-coder:14b",
              digest: "sha256:tool-capable-result",
              details: { parameter_size: "14B" },
            },
          ],
        });
      }
      if (url.includes("/api/show")) {
        const body = JSON.parse(String(init?.body)) as { model?: string; name?: string };
        if (body.name === "qwen2.5-coder:14b") {
          return jsonResponse({ capabilities: ["completion", "tools"] });
        }
        return jsonResponse({ capabilities: ["completion"] });
      }
      return jsonResponse({ error: "unexpected url" }, 500);
    };

    const status = await getOllamaStatus("http://localhost:11434/v1");

    assert.equal(status.ollamaModels?.[0]?.toolUseSupport, "supported");
    assert.deepEqual(status.models, ["qwen2.5-coder:14b"]);
  });
});

// ---------------------------------------------------------------------------
// isLikelyEmbeddingModelId
// ---------------------------------------------------------------------------

describe("isLikelyEmbeddingModelId", () => {
  test("should_detect_nomic_embed_text", () => {
    assert.equal(isLikelyEmbeddingModelId("nomic-embed-text"), true);
  });

  test("should_detect_mxbai_embed", () => {
    assert.equal(isLikelyEmbeddingModelId("mxbai-embed-large"), true);
  });

  test("should_detect_bge_prefix", () => {
    assert.equal(isLikelyEmbeddingModelId("bge-large-en"), true);
  });

  test("should_detect_org_slash_bge", () => {
    assert.equal(isLikelyEmbeddingModelId("BAAI/bge-large-en"), true);
  });

  test("should_detect_gte_prefix", () => {
    assert.equal(isLikelyEmbeddingModelId("gte-base"), true);
  });

  test("should_detect_e5_prefix", () => {
    assert.equal(isLikelyEmbeddingModelId("e5-large-v2"), true);
  });

  test("should_detect_jina_embeddings", () => {
    assert.equal(isLikelyEmbeddingModelId("jina-embeddings-v2"), true);
  });

  test("should_not_flag_qwen_model", () => {
    assert.equal(isLikelyEmbeddingModelId("qwen3.5:4b"), false);
  });

  test("should_not_flag_llama_model", () => {
    assert.equal(isLikelyEmbeddingModelId("llama3.1:8b"), false);
  });

  test("should_return_false_for_empty_string", () => {
    assert.equal(isLikelyEmbeddingModelId(""), false);
  });

  test("should_be_case_insensitive", () => {
    assert.equal(isLikelyEmbeddingModelId("Nomic-Embed-Text"), true);
  });
});

// ---------------------------------------------------------------------------
// isLmStudioModelUsableForChat
// ---------------------------------------------------------------------------

describe("isLmStudioModelUsableForChat", () => {
  test("should_accept_llm_type", () => {
    assert.equal(isLmStudioModelUsableForChat("qwen3.5:4b", "llm"), true);
  });

  test("should_accept_undefined_type", () => {
    assert.equal(isLmStudioModelUsableForChat("qwen3.5:4b"), true);
  });

  test("should_reject_embedding_type", () => {
    assert.equal(isLmStudioModelUsableForChat("some-model", "embedding"), false);
  });

  test("should_reject_vision_type", () => {
    assert.equal(isLmStudioModelUsableForChat("some-model", "vision"), false);
  });

  test("should_reject_embedding_model_even_with_llm_type", () => {
    assert.equal(isLmStudioModelUsableForChat("nomic-embed-text", "llm"), false);
  });

  test("should_be_case_insensitive_on_type", () => {
    assert.equal(isLmStudioModelUsableForChat("qwen3.5:4b", "LLM"), true);
  });

  test("should_trim_type_whitespace", () => {
    assert.equal(isLmStudioModelUsableForChat("qwen3.5:4b", "  llm  "), true);
  });
});

// ---------------------------------------------------------------------------
// inferLocalRuntimeFromBaseUrl
// ---------------------------------------------------------------------------

describe("inferLocalRuntimeFromBaseUrl", () => {
  test("should_return_ollama_for_undefined", () => {
    assert.equal(inferLocalRuntimeFromBaseUrl(undefined), "ollama");
  });

  test("should_return_ollama_for_empty_string", () => {
    assert.equal(inferLocalRuntimeFromBaseUrl(""), "ollama");
  });

  test("should_return_lmstudio_for_port_1234", () => {
    assert.equal(inferLocalRuntimeFromBaseUrl("http://localhost:1234/v1"), "lmstudio");
  });

  test("should_return_ollama_for_port_11434", () => {
    assert.equal(inferLocalRuntimeFromBaseUrl("http://localhost:11434/v1"), "ollama");
  });

  test("should_detect_lmstudio_in_hostname", () => {
    assert.equal(inferLocalRuntimeFromBaseUrl("http://lmstudio.local:5000"), "lmstudio");
  });

  test("should_detect_colon_1234_in_non_url_string", () => {
    assert.equal(inferLocalRuntimeFromBaseUrl("myhost:1234"), "lmstudio");
  });

  test("should_return_ollama_for_unknown_port", () => {
    assert.equal(inferLocalRuntimeFromBaseUrl("http://localhost:8080/v1"), "ollama");
  });
});

// ---------------------------------------------------------------------------
// resolveLocalModelToolUseSupport
// ---------------------------------------------------------------------------

describe("resolveLocalModelToolUseSupport", () => {
  test("should_return_supported_for_ollama_model_with_tools_capability", async () => {
    const requestBodies: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ capabilities: ["tools"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as any;
    };

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "ollama",
      baseURL: "http://localhost:11434/v1",
      modelId: "qwen3.5:4b",
    });

    assert.deepEqual(requestBodies, [
      { model: "qwen3.5:4b" },
      { name: "qwen3.5:4b" },
    ]);
    assert.deepEqual(result, { runtime: "ollama", support: "supported" });
  });

  test("should_return_unsupported_for_ollama_model_without_tools_capability", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ capabilities: ["vision"] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as any;

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "ollama",
      baseURL: "http://localhost:11434/v1",
      modelId: "qwen2.5:7b",
    });

    assert.deepEqual(result, { runtime: "ollama", support: "unsupported" });
  });

  test("should_return_supported_for_lmstudio_model_with_tool_use_flag", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        data: [
          {
            id: "unsloth/qwen3.5-4b",
            type: "llm",
            capabilities: { trained_for_tool_use: true },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as any;

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "lmstudio",
      baseURL: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      modelId: "unsloth/qwen3.5-4b",
    });

    assert.deepEqual(result, { runtime: "lmstudio", support: "supported" });
  });

  test("should_return_unsupported_for_lmstudio_model_without_tool_use_flag", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        data: [
          {
            id: "qwen2.5-7b-instruct",
            type: "llm",
            capabilities: { trained_for_tool_use: false },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as any;

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "lmstudio",
      baseURL: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      modelId: "qwen2.5-7b-instruct",
    });

    assert.deepEqual(result, { runtime: "lmstudio", support: "unsupported" });
  });

  test("should_report_model_not_installed_when_ollama_show_returns_404", async () => {
    // Live Ollama (verified on 0.30.7): POST /api/show for a model that is not
    // pulled answers 404 {"error":"model 'X' not found"} for both body shapes.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "model 'missing-model' not found" }),
      { status: 404 },
    ) as any;

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "ollama",
      baseURL: "http://localhost:11434/v1",
      modelId: "missing-model",
    });

    assert.deepEqual(result, {
      runtime: "ollama",
      support: "unknown",
      unknownReason: "model-not-installed",
    });
  });

  test("should_report_runtime_unreachable_when_ollama_connection_fails", async () => {
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    };

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "ollama",
      baseURL: "http://localhost:11434/v1",
      modelId: "qwen2.5:0.5b",
    });

    assert.deepEqual(result, {
      runtime: "ollama",
      support: "unknown",
      unknownReason: "runtime-unreachable",
    });
  });

  test("should_return_unknown_without_reason_when_ollama_show_returns_server_error", async () => {
    globalThis.fetch = async () => new Response("{}", { status: 500 }) as any;

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "ollama",
      baseURL: "http://localhost:11434/v1",
      modelId: "qwen2.5:0.5b",
    });

    assert.deepEqual(result, { runtime: "ollama", support: "unknown" });
  });

  test("should_prefer_positive_tools_signal_when_one_show_shape_fails", async () => {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if ("model" in body) {
        return new Response(
          JSON.stringify({ capabilities: ["completion", "tools"] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as any;
      }
      return new Response(
        JSON.stringify({ error: "model not found" }),
        { status: 404 },
      ) as any;
    };

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "ollama",
      baseURL: "http://localhost:11434/v1",
      modelId: "qwen2.5:0.5b",
    });

    assert.deepEqual(result, { runtime: "ollama", support: "supported" });
  });

  test("should_not_probe_ollama_cloud_as_local_ollama", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 }) as any;
    };

    const result = await resolveLocalModelToolUseSupport({
      modelProvider: "ollama-cloud",
      baseURL: "https://ollama.com/v1",
      modelId: "gpt-oss:20b",
    });

    assert.deepEqual(result, { runtime: null, support: "unknown" });
    assert.equal(fetchCalled, false);
  });
});

// ---------------------------------------------------------------------------
// formatLocalModelToolUseError
// ---------------------------------------------------------------------------

describe("formatLocalModelToolUseError", () => {
  test("should_return_null_when_tool_use_is_supported", () => {
    assert.equal(
      formatLocalModelToolUseError(
        { runtime: "ollama", support: "supported" },
        "qwen2.5:0.5b",
      ),
      null,
    );
  });

  test("should_return_null_for_non_local_runtime", () => {
    assert.equal(
      formatLocalModelToolUseError(
        { runtime: null, support: "unknown" },
        "gpt-oss:20b",
      ),
      null,
    );
  });

  test("should_name_ollama_as_not_running_when_runtime_unreachable", () => {
    // "Ollama" + "not running" is what thread-error-display matches to show
    // the dedicated ollama_not_running error UI.
    assert.equal(
      formatLocalModelToolUseError(
        { runtime: "ollama", support: "unknown", unknownReason: "runtime-unreachable" },
        "qwen2.5:0.5b",
      ),
      "Ollama is not running or not reachable. Start Ollama and try again.",
    );
  });

  test("should_explain_how_to_install_a_missing_ollama_model", () => {
    assert.equal(
      formatLocalModelToolUseError(
        { runtime: "ollama", support: "unknown", unknownReason: "model-not-installed" },
        "qwen2.5:0.5b",
      ),
      'Ollama model "qwen2.5:0.5b" is not installed. Pull it with "ollama pull qwen2.5:0.5b" or pick a different model in Settings, then start a new chat.',
    );
  });

  test("should_keep_no_tools_message_for_unsupported_models", () => {
    assert.equal(
      formatLocalModelToolUseError(
        { runtime: "ollama", support: "unsupported" },
        "deepseek-r1:8b",
      ),
      'Ollama model "deepseek-r1:8b" does not support tools. Change the model in Settings and start a new chat.',
    );
  });

  test("should_keep_unverified_message_when_cause_is_unknown", () => {
    assert.equal(
      formatLocalModelToolUseError(
        { runtime: "lmstudio", support: "unknown" },
        "qwen2.5-7b-instruct",
      ),
      'LM Studio model "qwen2.5-7b-instruct" could not be verified for tool use. Change the model in Settings and start a new chat.',
    );
  });
});
