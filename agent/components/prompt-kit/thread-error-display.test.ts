import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  formatTurnError,
  INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE,
  INTERPRETER_HOSTED_OVERLOADED_MESSAGE,
} from "../../../src/lib/codex/errors";
import i18n from "../../../src/i18n";
import {
  buildInterpreterCreditsExhaustedMessage,
  buildInterpreterCreditsExhaustedSuggestion,
  parseError,
  shouldShowProfileSwitchWarning,
  splitTextIntoLinkParts,
} from "./thread-error-display";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertShape(result: ReturnType<typeof parseError>) {
  assert.equal(typeof result.type, "string");
  assert.equal(typeof result.title, "string");
  assert.equal(typeof result.message, "string");
  assert.equal(typeof result.suggestion, "string");
  assert.ok(result.title.length > 0, "title must be non-empty");
  assert.ok(result.message.length > 0, "message must be non-empty");
}

function assertInterpreterCreditsExhausted(
  result: ReturnType<typeof parseError>,
  planStatus: Parameters<typeof buildInterpreterCreditsExhaustedMessage>[0] = "unknown",
) {
  assertShape(result);
  assert.equal(result.type, "interpreter_credits_exhausted");
  assert.equal(result.title, "Interpreter tokens exhausted");
  assert.equal(result.message, buildInterpreterCreditsExhaustedMessage(planStatus));
  assert.equal(result.suggestion, buildInterpreterCreditsExhaustedSuggestion(planStatus));
}

function assertNoOllamaCopy(result: ReturnType<typeof parseError>) {
  assert.doesNotMatch(result.title, /Ollama/i);
  assert.doesNotMatch(result.message, /Ollama/i);
  assert.doesNotMatch(result.suggestion, /Ollama/i);
}

describe("splitTextIntoLinkParts", () => {
  test("strips_trailing_parenthesis_from_clickable_url", () => {
    const parts = splitTextIntoLinkParts(
      "stream disconnected before completion: error sending request for url (http://localhost:1234/v1/responses)",
    );
    assert.deepEqual(parts, [
      { type: "text", text: "stream disconnected before completion: error sending request for url (" },
      { type: "link", text: "http://localhost:1234/v1/responses" },
      { type: "text", text: ")" },
    ]);
  });

  test("strips_trailing_period_from_clickable_url", () => {
    const parts = splitTextIntoLinkParts(
      "Interpreter could not connect to the LM Studio local server at http://localhost:1234.",
    );
    assert.deepEqual(parts, [
      { type: "text", text: "Interpreter could not connect to the LM Studio local server at " },
      { type: "link", text: "http://localhost:1234" },
      { type: "text", text: "." },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 1. Structured object detection (status codes & error types)
// ---------------------------------------------------------------------------

describe("parseError / structured objects", () => {
  test("status_429_returns_rate_limit", () => {
    const r = parseError({ status: 429 });
    assertShape(r);
    assert.equal(r.type, "rate_limit");
  });

  test("status_429_with_provider_uses_provider_name_in_title", () => {
    const r = parseError({ status: 429 }, "groq");
    assertShape(r);
    assert.equal(r.type, "rate_limit");
    assert.equal(r.title, "Too many requests to Groq");
  });

  test("status_401_returns_auth", () => {
    const r = parseError({ status: 401 });
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("status_401_with_provider_uses_provider_name_in_title", () => {
    const r = parseError({ status: 401 }, "openai-oauth");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "ChatGPT authentication failed");
  });

  test("status_403_returns_auth", () => {
    const r = parseError({ status: 403 });
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("status_500_returns_server", () => {
    const r = parseError({ status: 500 });
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("status_402_without_user_credit_signal_returns_provider_error", () => {
    const r = parseError({ status: 402 });
    assertShape(r);
    assert.equal(r.type, "provider_error");
    assert.equal(r.title, "Provider payment error");
    assert.equal(r.suggestion, "This may be temporary. Try again, or switch provider/profile.");
  });

  test("status_402_without_user_credit_signal_uses_provider_specific_copy_when_provider_is_present", () => {
    const r = parseError({ status: 402 }, "openai-oauth");
    assertShape(r);
    assert.equal(r.type, "provider_error");
    assert.equal(r.title, "ChatGPT payment error");
    assert.equal(r.message, "ChatGPT returned a payment-required response.");
    assert.equal(r.suggestion, "This may be temporary. Try again, or switch to a profile that does not use ChatGPT.");
  });

  test("status_402_with_user_credits_signal_returns_interpreter_credits_exhausted_with_free_copy", () => {
    const r = parseError({ status: 402, type: "user_credits_exhausted" }, undefined, undefined, false);
    assertInterpreterCreditsExhausted(r, "free");
  });

  test("status_502_returns_server", () => {
    const r = parseError({ status: 502 });
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("status_503_returns_service_unavailable", () => {
    const r = parseError({ status: 503 });
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Models temporarily unavailable");
    assert.equal(r.message, "Interpreter hosted models are temporarily unavailable.");
  });

  test("status_503_with_ollama_provider_returns_local_service_unavailable", () => {
    const r = parseError({ status: 503 }, "ollama");
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Ollama temporarily unavailable");
    assert.equal(r.message, "The Ollama server returned a temporary service-unavailable response.");
  });

  test("statusCode_field_is_also_recognized", () => {
    const r = parseError({ statusCode: 429 });
    assertShape(r);
    assert.equal(r.type, "rate_limit");
  });

  test("code_field_is_also_recognized", () => {
    const r = parseError({ code: 401 });
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("type_rate_limit_error_returns_rate_limit", () => {
    const r = parseError({ type: "rate_limit_error" });
    assertShape(r);
    assert.equal(r.type, "rate_limit");
  });

  test("type_rate_limit_returns_rate_limit", () => {
    const r = parseError({ type: "rate_limit" });
    assertShape(r);
    assert.equal(r.type, "rate_limit");
  });

  test("error_type_authentication_error_returns_auth", () => {
    const r = parseError({ error_type: "authentication_error" });
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("error_type_authentication_error_with_provider_uses_provider_name_in_title", () => {
    const r = parseError({ error_type: "authentication_error" }, "hosted");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Interpreter authentication failed");
  });

  test("type_unauthorized_returns_auth", () => {
    const r = parseError({ type: "unauthorized" });
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("type_server_error_returns_server", () => {
    const r = parseError({ type: "server_error" });
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("type_internal_server_error_returns_server", () => {
    const r = parseError({ type: "internal_server_error" });
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("type_payment_required_without_user_credit_signal_returns_provider_error", () => {
    const r = parseError({ type: "payment_required" });
    assertShape(r);
    assert.equal(r.type, "provider_error");
    assert.equal(r.title, "Provider payment error");
    assert.equal(r.suggestion, "This may be temporary. Try again, or switch provider/profile.");
  });

  test("type_payment_required_without_user_credit_signal_uses_provider_specific_copy_when_provider_is_present", () => {
    const r = parseError({ type: "payment_required" }, "api");
    assertShape(r);
    assert.equal(r.type, "provider_error");
    assert.equal(r.title, "API provider payment error");
    assert.equal(r.message, "API provider returned a payment-required response.");
    assert.equal(r.suggestion, "This may be temporary. Try again, or switch to a profile that does not use API provider.");
  });

  test("type_payment_required_with_explicit_user_credit_signal_returns_interpreter_credits_exhausted", () => {
    const r = parseError({
      type: "payment_required",
      message: "[not_enough_tokens]: User has insufficient interpreter tokens. Please buy more interpreter tokens",
    }, undefined, undefined, false);
    assertInterpreterCreditsExhausted(r, "free");
  });

  test("type_user_credits_exhausted_returns_interpreter_credits_exhausted_with_paid_copy", () => {
    const r = parseError({ type: "user_credits_exhausted" }, undefined, undefined, true);
    assertInterpreterCreditsExhausted(r, "paid");
  });
});

// ---------------------------------------------------------------------------
// 2. String pattern detection
// ---------------------------------------------------------------------------

describe("parseError / string patterns", () => {
  test("should_detect_encrypted_content_invalid_from_formatted_errors_ts_message", () => {
    const r = parseError("Conversation encrypted content is invalid (organization mismatch). This conversation is unrecoverable.");
    assertShape(r);
    assert.equal(r.type, "encrypted_content_invalid");
    assert.equal(r.title, "Conversation expired");
    assert.equal(r.suggestion, "Start a new conversation. This one cannot be recovered.");
  });

  test("should_detect_formatted_custom_endpoint_responses_404", () => {
    const additionalDetails = 'unexpected status 404 Not Found: {"detail":"Not Found"}, url: https://api.cerebras.ai/v1/responses';
    const formatted = formatTurnError(
      {
        message: 'raw',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 404 } },
        additionalDetails,
      },
      { modelProvider: 'custom', providerLabel: 'Custom Endpoint' },
    );
    const r = parseError(formatted, 'api', additionalDetails, undefined, 'https://api.cerebras.ai/v1');
    assertShape(r);
    assert.equal(r.type, "unsupported_responses_endpoint");
    assert.equal(r.title, "Provider URL does not support Responses API");
    assert.equal(r.message, "The custom profile URL points to cerebras.ai, which does not support the OpenAI Responses format.");
    assert.equal(
      r.suggestion,
      "Try switching to a natively supported provider in Settings > Profiles, such as Interpreter, Groq, OpenRouter, or OpenAI.",
    );
  });

  test("should_classify_outdated_ollama_404_as_local_runtime_outdated_not_generic_responses", () => {
    const additionalDetails =
      'unexpected status 404 Not Found from http://localhost:11434/v1/responses: 404 page not found';
    const formatted = formatTurnError(
      {
        message: 'Response stream failed to connect',
        codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 404 } },
        additionalDetails,
      },
      { modelProvider: 'ollama', localProviderVersion: '0.12.11' },
    );
    const r = parseError(formatted, 'ollama', additionalDetails, undefined, 'http://localhost:11434/v1');
    assertShape(r);
    assert.equal(r.type, "local_runtime_outdated");
    assert.equal(r.title, "Update Ollama to continue");
    assert.match(r.message, /0\.12\.11/);
    assert.match(r.message, /v0\.13\.4/);
  });

  test("should_fallback_when_formatted_custom_endpoint_responses_404_has_no_url", () => {
    const r = parseError(
      "API endpoint not found. This base URL may not support the OpenAI Responses API (/responses). Use a supported Responses provider URL or OpenRouter.",
      'api',
    );
    assertShape(r);
    assert.equal(r.type, "unsupported_responses_endpoint");
    assert.equal(r.message, "The custom profile URL you entered does not support the OpenAI Responses format.");
  });

  test("should_detect_raw_responses_404_for_custom_endpoint", () => {
    const r = parseError(
      'unexpected status 404 Not Found: {"detail":"Not Found"}, url: https://api.cerebras.ai/v1/responses',
      'api',
      undefined,
      undefined,
      'https://api.cerebras.ai/v1',
    );
    assertShape(r);
    assert.equal(r.type, "unsupported_responses_endpoint");
    assert.equal(r.message, "The custom profile URL points to cerebras.ai, which does not support the OpenAI Responses format.");
  });

  test("should_treat_openrouter_no_endpoints_found_as_invalid_model", () => {
    const r = parseError(
      'unexpected status 404 Not Found: No endpoints found for qwen/qwen3-4b:free., url: https://openrouter.ai/api/v1/responses',
      'openrouter',
      undefined,
      undefined,
      'https://openrouter.ai/api/v1',
    );
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(r.title, "Invalid OpenRouter model ID");
    assert.ok(r.message.includes("No endpoints found for qwen/qwen3-4b:free"));
    assert.equal(
      r.suggestion,
      "Check the model ID in Settings > Models for your OpenRouter profile. OpenRouter model IDs should include the upstream provider prefix, e.g. `openai/gpt-5.4`.",
    );
  });

  test("should_explain_hosted_no_tool_capable_route_as_model_tool_support", () => {
    const error =
      'unexpected status 404 Not Found: {"error":{"detail":"{\\"error\\":{\\"message\\":\\"No endpoints found that support tool use. Try disabling \\\\\\"shell\\\\\\". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection\\",\\"code\\":404}}"}}';
    const formatted = formatTurnError({
      message: error,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 404 } },
      additionalDetails: error,
    });

    const r = parseError(formatted, 'hosted', error);

    assertShape(r);
    assert.equal(r.type, "model_no_tools");
    assert.equal(r.title, "Model does not support tools");
    assert.equal(
      r.message,
      "Interpreter does not serve this model as tool-capable, so it cannot run agent tools.",
    );
    assert.equal(
      r.suggestion,
      "Switch to another model in Settings > Models.",
    );
  });

  test("should_explain_openrouter_no_tool_capable_route_as_model_tool_support", () => {
    const formatted =
      "This model is not available through a tool-capable route, so it cannot run Interpreter agent tools.";

    const r = parseError(formatted, 'openrouter');

    assertShape(r);
    assert.equal(r.type, "model_no_tools");
    assert.equal(r.title, "Model does not support tools");
    assert.equal(
      r.message,
      "OpenRouter does not serve this model as tool-capable, so it cannot run agent tools.",
    );
    assert.equal(
      r.suggestion,
      "Switch to another model in Settings > Models.",
    );
  });

  test("should_explain_hosted_no_image_capable_route_as_model_image_support", () => {
    const error =
      'unexpected status 404 Not Found: {"error":{"detail":"{\\"error\\":{\\"message\\":\\"No endpoints found that support image input\\",\\"code\\":404}}"}}';
    const formatted = formatTurnError({
      message: "Reconnecting... 1/5",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 404 } },
      additionalDetails: error,
    });

    const r = parseError(formatted, 'hosted', error);

    assertShape(r);
    assert.equal(r.type, "model_no_images");
    assert.equal(r.title, "Model does not support images");
    assert.equal(
      r.message,
      "Interpreter does not serve this model as image-capable, so it cannot inspect screenshots or images.",
    );
    assert.equal(
      r.suggestion,
      "Switch to another model in Settings > Models.",
    );
  });

  test("should_explain_raw_hosted_no_image_capable_route_as_model_image_support", () => {
    const error =
      'unexpected status 404 Not Found: {"error":{"detail":"{\\"error\\":{\\"message\\":\\"No endpoints found that support image input\\",\\"code\\":404}}"}}';

    const r = parseError(error, 'hosted');

    assertShape(r);
    assert.equal(r.type, "model_no_images");
    assert.equal(r.title, "Model does not support images");
    assert.equal(
      r.message,
      "Interpreter does not serve this model as image-capable, so it cannot inspect screenshots or images.",
    );
    assert.equal(
      r.suggestion,
      "Switch to another model in Settings > Models.",
    );
  });

  test("should_detect_custom_endpoint_validation_error_for_responses_input_shape", () => {
    const r = parseError(
      "{\"error\":{\"message\":\"426 validation errors:\\n {'type': 'string_type', 'loc': ('body', 'input', 'str'), 'msg': 'Input should be a valid string'}\"}}",
      'api',
      undefined,
      undefined,
      'http://192.168.0.115:8000/v1',
    );
    assertShape(r);
    assert.equal(r.type, "unsupported_responses_endpoint");
    assert.equal(r.message, "The custom profile URL points to 192.168.0.115, which does not support the OpenAI Responses format.");
    assert.equal(
      r.suggestion,
      "Try switching to a natively supported provider in Settings > Profiles, such as Interpreter, Groq, OpenRouter, or OpenAI.",
    );
  });

  test("should_detect_raw_validation_error_for_responses_tool_calling_contract", () => {
    const r = parseError(
      'unexpected status 426 Upgrade Required: {"detail":"1 validation error for Request\\ninput\\n  Input should be a valid string"}',
      'api',
    );
    assertShape(r);
    assert.equal(r.type, "responses_contract_incompatible");
    assert.equal(r.title, "Endpoint/model incompatible");
    assert.equal(
      r.message,
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("should_explain_local_function_tool_endpoint_rejection_with_settings_guidance", () => {
    const formatted = formatTurnError(
      {
        message: JSON.stringify({
          error: {
            code: 400,
            message: "'type' of tool must be 'function'",
            type: "invalid_request_error",
          },
        }),
        codexErrorInfo: "other",
        additionalDetails: null,
      },
      { modelProvider: "custom", providerLabel: "Custom Endpoint" },
    );

    const r = parseError(
      formatted,
      "api",
      null,
      null,
      "http://127.0.0.1:8070/v1",
    );

    assertShape(r);
    assert.equal(r.type, "responses_contract_incompatible");
    assert.equal(r.title, "Local API server cannot run Interpreter agents");
    assert.equal(
      r.message,
      "The local or self-hosted API server at 127.0.0.1 rejected Interpreter's agent tool format. It appears to accept only function tools, but Interpreter agents require Responses API custom tools.",
    );
    assert.equal(
      r.suggestion,
      "For local models, use the Local (Ollama / LM Studio) profile in Settings > Profiles. It has the best-supported local model path. Custom servers such as llama.cpp need Responses API custom tool support before they can run Interpreter agents.",
    );
  });

  test("issue_1293_should_explain_local_tools_index_type_rejection_with_settings_guidance", () => {
    const formatted = formatTurnError(
      {
        message: '{ "error": { "message": "Invalid", "type": "invalid_request_error", "param": "tools.16.type", "code": "invalid_string" } }',
        codexErrorInfo: "other",
        additionalDetails: null,
      },
      { modelProvider: "lmstudio-a4fec4cc", providerLabel: "LM Studio" },
    );

    const r = parseError(
      formatted,
      "api",
      null,
      null,
      "http://127.0.0.1:1234/v1",
    );

    assertShape(r);
    assert.equal(r.type, "responses_contract_incompatible");
    assert.equal(r.title, "Local API server cannot run Interpreter agents");
    assert.equal(
      r.message,
      "The local or self-hosted API server at 127.0.0.1 rejected Interpreter's agent tool format. It appears to accept only function tools, but Interpreter agents require Responses API custom tools.",
    );
    assert.equal(
      r.suggestion,
      "For local models, use the Local (Ollama / LM Studio) profile in Settings > Profiles. It has the best-supported local model path. Custom servers such as llama.cpp need Responses API custom tool support before they can run Interpreter agents.",
    );
  });

  test("should_keep_remote_custom_function_tool_endpoint_guidance_provider_focused", () => {
    const r = parseError(
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
      "api",
      null,
      null,
      "https://api.example.com/v1",
    );

    assertShape(r);
    assert.equal(r.type, "responses_contract_incompatible");
    assert.equal(r.title, "Custom endpoint cannot run Interpreter agents");
    assert.equal(
      r.message,
      "The custom API server at example.com does not support the Responses API tool format required by Interpreter agents.",
    );
    assert.equal(
      r.suggestion,
      "Open Settings > Profiles and switch to Interpreter, OpenRouter, OpenAI, or another provider with Responses API custom tool support.",
    );
  });

  test("should_preserve_specific_openai_custom_tool_model_guidance", () => {
    const formatted = formatTurnError(
      {
        message: "{ \"error\": { \"message\": \"Invalid value: 'custom'\", \"type\": \"invalid_request_error\", \"param\": \"tools\" } }",
        codexErrorInfo: "other",
        additionalDetails: null,
      },
      { modelProvider: "openai-api", providerLabel: "OpenAI API" },
    );

    const r = parseError(formatted, "api");

    assertShape(r);
    assert.equal(r.type, "responses_contract_incompatible");
    assert.equal(
      r.message,
      "This OpenAI model does not support Interpreter's custom/freeform agent tools. Use gpt-5.4-nano, or another model that supports Responses custom tools.",
    );
  });

  test("should_use_request_endpoint_snapshot_for_custom_endpoint_404", () => {
    const r = parseError(
      'unexpected status 404 Not Found: {"detail":"Not Found"}, url: https://wrong.example.com/v1/responses',
      'api',
      undefined,
      undefined,
      'https://api.deepseek.com/v1',
    );
    assertShape(r);
    assert.equal(r.type, "unsupported_responses_endpoint");
    assert.equal(r.message, "The custom profile URL points to deepseek.com, which does not support the OpenAI Responses format.");
  });

  test("should_detect_encrypted_content_invalid_with_provider_context", () => {
    const r = parseError(
      "Conversation encrypted content is invalid (organization mismatch). This conversation is unrecoverable.",
      "openai-oauth",
    );
    assertShape(r);
    assert.equal(r.type, "encrypted_content_invalid");
    assert.equal(r.title, "Conversation expired");
    assert.ok(r.message.includes("ChatGPT"));
    assert.equal(r.suggestion, "Start a new conversation. This one cannot be recovered.");
  });

  test("should_detect_raw_invalid_encrypted_content_error_from_codex", () => {
    const r = parseError(
      '{ "type": "error", "error": { "type": "invalid_request_error", "code": "invalid_encrypted_content" }, "status": 400 }',
      "openai-oauth",
    );
    assertShape(r);
    assert.equal(r.type, "encrypted_content_invalid");
    assert.ok(r.message.includes("ChatGPT"));
  });

  test("lmstudio_backend_dlopen_failure_returns_lmstudio_backend_error", () => {
    const r = parseError(
      'Failed to load model "google/functiongemma-270m". Error: Failed to load LLM engine from path: /Users/test/.lmstudio/extensions/backends/mlx-llm-mac-arm64-apple-metal-advsimd-1.4.0/llm_engine_mlx_amphibian.node. dlopen(...): Library not loaded: @rpath/libpython3.11.dylib',
    );
    assertShape(r);
    assert.equal(r.type, "lmstudio_backend_error");
    assert.equal(r.title, "LM Studio backend failed to load");
    assert.ok(r.suggestion.includes("1645"));
  });

  test("lmstudio_backend_library_not_loaded_returns_lmstudio_backend_error", () => {
    const r = parseError(
      'Failed to load LLM engine from path: /some/path/llm_engine_mlx.node. Library not loaded: @rpath/libpython3.11.dylib',
    );
    assertShape(r);
    assert.equal(r.type, "lmstudio_backend_error");
  });

  test("no_models_loaded_returns_lmstudio_no_models", () => {
    const r = parseError("No models loaded. Please load a model in the developer page or use the 'lms load' command.");
    assertShape(r);
    assert.equal(r.type, "lmstudio_no_models");
    assert.equal(r.title, "No models loaded in LM Studio");
  });

  test("no_models_loaded_bare_returns_lmstudio_no_models", () => {
    const r = parseError("No models loaded");
    assertShape(r);
    assert.equal(r.type, "lmstudio_no_models");
  });

  test("claude_not_installed_returns_claude_code_not_installed", () => {
    const r = parseError("Claude Code is not installed on this machine");
    assertShape(r);
    assert.equal(r.type, "claude_code_not_installed");
  });

  test("claude_spawn_returns_claude_code_not_installed", () => {
    const r = parseError("Failed to spawn claude process");
    assertShape(r);
    assert.equal(r.type, "claude_code_not_installed");
  });

  test("claude_enoent_returns_claude_code_not_installed", () => {
    const r = parseError("claude: ENOENT: no such file");
    assertShape(r);
    assert.equal(r.type, "claude_code_not_installed");
  });

  test("acp_spawn_returns_acp_not_available", () => {
    const r = parseError("Failed to spawn acp process");
    assertShape(r);
    assert.equal(r.type, "acp_not_available");
  });

  test("acp_enoent_returns_acp_not_available", () => {
    const r = parseError("acp: ENOENT: no such file");
    assertShape(r);
    assert.equal(r.type, "acp_not_available");
  });

  test("econnrefused_11434_returns_ollama_not_running", () => {
    const r = parseError("ECONNREFUSED 127.0.0.1:11434");
    assertShape(r);
    assert.equal(r.type, "ollama_not_running");
  });

  test("ollama_not_running_string_returns_ollama_not_running", () => {
    const r = parseError("Ollama is not running");
    assertShape(r);
    assert.equal(r.type, "ollama_not_running");
  });

  test("tool_use_probe_unreachable_message_returns_ollama_not_running", () => {
    const r = parseError("Ollama is not running or not reachable. Start Ollama and try again.");
    assertShape(r);
    assert.equal(r.type, "ollama_not_running");
  });

  test("tool_use_probe_model_not_installed_message_keeps_actionable_text", () => {
    const r = parseError(
      'Ollama model "qwen2.5:0.5b" is not installed. Pull it with "ollama pull qwen2.5:0.5b" or pick a different model in Settings, then start a new chat.',
    );
    assertShape(r);
    assert.equal(r.type, "unknown");
    assert.match(r.message, /ollama pull qwen2\.5:0\.5b/);
  });

  test("lmstudio_localhost_request_send_failure_returns_lmstudio_not_running", () => {
    const r = parseError(
      "stream disconnected before completion: error sending request for url (http://localhost:1234/v1/responses)",
      "local",
    );
    assertShape(r);
    assert.equal(r.type, "lmstudio_not_running");
    assert.equal(r.title, "LM Studio is not running");
  });

  test("lmstudio_request_send_failure_without_provider_still_returns_lmstudio_not_running", () => {
    const r = parseError(
      "stream disconnected before completion: error sending request for url (http://127.0.0.1:1234/v1/responses)",
    );
    assertShape(r);
    assert.equal(r.type, "lmstudio_not_running");
  });

  test("ollama_localhost_request_send_failure_returns_ollama_not_running", () => {
    const r = parseError(
      "stream disconnected before completion: error sending request for url (http://localhost:11434/v1/responses)",
      "local",
    );
    assertShape(r);
    assert.equal(r.type, "ollama_not_running");
    assert.equal(r.title, "Ollama is not running");
  });

  test("ollama_request_send_failure_without_provider_still_returns_ollama_not_running", () => {
    const r = parseError(
      "stream disconnected before completion: error sending request for url (http://127.0.0.1:11434/v1/responses)",
    );
    assertShape(r);
    assert.equal(r.type, "ollama_not_running");
  });

  test("model_not_found_ollama_returns_ollama_model_missing", () => {
    const r = parseError("model 'llama3' not found in ollama, try pulling it first");
    assertShape(r);
    assert.equal(r.type, "ollama_model_missing");
  });

  test("model_does_not_exist_with_11434_returns_ollama_model_missing", () => {
    const r = parseError("model 'foo' does not exist on 11434");
    assertShape(r);
    assert.equal(r.type, "ollama_model_missing");
  });

  test("bare_model_not_found_returns_ollama_model_missing", () => {
    const r = parseError("model 'qwen3:8b' not found");
    assertShape(r);
    assert.equal(r.type, "ollama_model_missing");
    assert.equal(r.title, "Model not found");
  });

  test("bare_model_not_found_with_status_404_returns_ollama_model_missing", () => {
    const r = parseError("unexpected status 404 Not Found: model 'qwen3:8b' not found, url:");
    assertShape(r);
    assert.equal(r.type, "ollama_model_missing");
  });

  test("provider_model_does_not_exist_or_access_denied_returns_invalid_model", () => {
    const r = parseError(
      "unexpected status 404 Not Found: The model `moonshotai/kimi-k2-instruct-0905` does not exist or you do not have access to it., url: http://localhost:5177/api/agent/groq-proxy/responses",
      "groq",
    );
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(r.title, "Invalid Groq model ID");
    assert.equal(
      r.suggestion,
      "Check the model ID in Settings > Models for your Groq profile.",
    );
  });

  test("ollama_model_missing_preserves_raw_message", () => {
    const raw = "model 'deepseek' not found in ollama, try pulling it first";
    const r = parseError(raw);
    assert.equal(r.message, raw);
  });

  test("groq_model_not_found_from_issue_log_empty_url_does_not_return_ollama_guidance", () => {
    const raw = "unexpected status 404 Not Found: The model `moonshotai/kimi-k2-instruct-0905` does not exist or you do not have access to it., url: , cf-ray: 9f5327a90e2ad92d-LIS, request id: req_01kqk3w250ff4r4vmdy8w36ky7";
    const r = parseError(raw, "groq", null, null, "https://api.groq.com/openai/v1");
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(r.title, "Invalid Groq model ID");
    assert.equal(r.message, raw);
    assert.equal(r.suggestion, "Check the model ID in Settings > Models for your Groq profile.");
    assertNoOllamaCopy(r);
  });

  test("groq_model_not_found_json_string_does_not_return_ollama_guidance", () => {
    const r = parseError(
      JSON.stringify({
        error: {
          message: "The model `moonshotai/kimi-k2-instruct-0905` does not exist or you do not have access to it.",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      }),
      "groq",
      null,
      null,
      "https://api.groq.com/openai/v1",
    );
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(r.title, "Invalid Groq model ID");
    assert.equal(
      r.message,
      "The model `moonshotai/kimi-k2-instruct-0905` does not exist or you do not have access to it.",
    );
    assertNoOllamaCopy(r);
  });

  test("groq_model_not_found_object_does_not_return_ollama_guidance", () => {
    const r = parseError(
      {
        status: 404,
        error: {
          message: "The model `moonshotai/kimi-k2-instruct-0905` does not exist or you do not have access to it.",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      "groq",
      null,
      null,
      "https://api.groq.com/openai/v1",
    );
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(r.title, "Invalid Groq model ID");
    assert.equal(
      r.message,
      "The model `moonshotai/kimi-k2-instruct-0905` does not exist or you do not have access to it.",
    );
    assertNoOllamaCopy(r);
  });

  test("does_not_support_tools_returns_local_model_no_tools", () => {
    const r = parseError("registry.ollama.ai/library/deepseek-r1:8b does not support tools");
    assertShape(r);
    assert.equal(r.type, "local_model_no_tools");
    assert.equal(r.title, "Model does not support tools");
  });

  test("does_not_support_tools_generic_returns_local_model_no_tools", () => {
    const r = parseError("registry.ollama.ai/library/vision-ai:latest does not support tools");
    assertShape(r);
    assert.equal(r.type, "local_model_no_tools");
  });

  test("not_connected_openai_returns_auth_provider_variant", () => {
    const r = parseError("OpenAI is not connected to your account");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Provider not connected");
  });

  test("not_connected_claude_returns_auth_provider_variant", () => {
    const r = parseError("Claude provider is not connected");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Provider not connected");
  });

  test("not_connected_oauth_returns_auth_provider_variant", () => {
    const r = parseError("OAuth is not connected");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Provider not connected");
  });

  test("not_connected_provider_returns_auth_provider_variant", () => {
    const r = parseError("Provider is not connected");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Provider not connected");
  });

  test("not_connected_with_provider_uses_provider_name_in_title", () => {
    const r = parseError("Provider is not connected", "claude-oauth");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Claude not connected");
  });

  test("unauthorized_string_returns_auth", () => {
    const r = parseError("Unauthorized access to resource");
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("authentication_string_returns_auth", () => {
    const r = parseError("Authentication failed for this request");
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("missing_authorization_header_payload_with_hosted_provider_uses_interpreter_auth_title", () => {
    const rawPayload = '{"error":[{"type":"missing","loc":["header","authorization"],"msg":"Field required","input":null}]}';
    const formatted = formatTurnError({
      message: rawPayload,
      codexErrorInfo: "other",
      additionalDetails: null,
    });
    const r = parseError(formatted, "hosted");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Interpreter authentication failed");
    assert.equal(r.message, "The request was not authorized.");
  });

  test("authentication_string_with_provider_uses_provider_name_in_title", () => {
    const r = parseError("Authentication failed for this request", "hosted");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Interpreter authentication failed");
  });

  test("sign_in_string_returns_auth", () => {
    const r = parseError("Please sign in to continue");
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("session_expired_returns_session_expired", () => {
    const r = parseError("Your session has expired");
    assertShape(r);
    assert.equal(r.type, "session_expired");
  });

  test("session_does_not_exist_returns_session_expired", () => {
    const r = parseError("Session does not exist");
    assertShape(r);
    assert.equal(r.type, "session_expired");
  });

  test("session_invalid_returns_session_expired", () => {
    const r = parseError("Session is invalid");
    assertShape(r);
    assert.equal(r.type, "session_expired");
  });

  test("jwt_expired_returns_session_expired", () => {
    const r = parseError("JWT token has expired");
    assertShape(r);
    assert.equal(r.type, "session_expired");
  });

  test("jwt_invalid_returns_session_expired", () => {
    const r = parseError("JWT is invalid");
    assertShape(r);
    assert.equal(r.type, "session_expired");
  });

  test("jwt_does_not_exist_returns_session_expired", () => {
    const r = parseError("JWT does not exist");
    assertShape(r);
    assert.equal(r.type, "session_expired");
  });

  test("usage_limit_returns_provider_usage_limit", () => {
    const r = parseError("You have reached your usage limit");
    assertShape(r);
    assert.equal(r.type, "provider_usage_limit");
  });

  test("usage_limit_returns_provider_specific_copy_when_provider_is_present", () => {
    const r = parseError("You have reached your usage limit", "groq");
    assertShape(r);
    assert.equal(r.type, "provider_usage_limit");
    assert.equal(r.title, "Groq usage limit reached");
    assert.equal(r.message, "Groq has reached its usage limit.");
    assert.equal(
      r.suggestion,
      "Wait for Groq limits to reset, or switch to a profile that does not use Groq. Groq limits are separate from Interpreter credits shown in Settings > Plan.",
    );
  });

  for (const { provider, name } of [
    { provider: "openai-oauth", name: "ChatGPT" },
    { provider: "groq", name: "Groq" },
    { provider: "openrouter", name: "OpenRouter" },
    { provider: "api", name: "API provider" },
  ]) {
    test(`usage_limit_for_${provider}_explains_provider_limits_are_separate_from_interpreter_credits`, () => {
      const r = parseError("You have reached your usage limit", provider);
      assertShape(r);
      assert.equal(r.type, "provider_usage_limit");
      assert.equal(r.title, `${name} usage limit reached`);
      assert.equal(
        r.suggestion,
        `Wait for ${name} limits to reset, or switch to a profile that does not use ${name}. ${name} limits are separate from Interpreter credits shown in Settings > Plan.`,
      );
    });
  }

  for (const provider of ["hosted", "interpreter"]) {
    test(`usage_limit_for_${provider}_does_not_describe_interpreter_limits_as_separate_from_interpreter_credits`, () => {
      const r = parseError("You have reached your usage limit", provider);
      assertShape(r);
      assert.equal(r.type, "provider_usage_limit");
      assert.equal(r.title, "Interpreter usage limit reached");
      assert.equal(
        r.suggestion,
        "Wait for Interpreter limits to reset, or switch to a profile that does not use Interpreter. Interpreter provider limits are separate from external provider account limits.",
      );
    });
  }

  test("usage_limit_with_window_and_reset_details_preserves_detailed_message", () => {
    const detailedMessage = "Usage limit exceeded. Window: 180 minutes. Resets at: 2026-03-20T18:00:00Z.";
    const r = parseError(detailedMessage, "openai-oauth");
    assertShape(r);
    assert.equal(r.type, "provider_usage_limit");
    assert.equal(r.title, "ChatGPT usage limit reached");
    assert.equal(r.message, detailedMessage);
    assert.equal(
      r.suggestion,
      "Wait for ChatGPT limits to reset, or switch to a profile that does not use ChatGPT. ChatGPT limits are separate from Interpreter credits shown in Settings > Plan.",
    );
  });

  test("chatgpt_usage_limit_sentence_uses_interpreter_copy", () => {
    const detailedMessage = "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at May 31st, 2026 8:34 AM.";
    const r = parseError(detailedMessage, "openai-oauth");
    assertShape(r);
    assert.equal(r.type, "provider_usage_limit");
    assert.equal(r.title, "ChatGPT usage limit reached");
    assert.equal(r.message, "You've hit your ChatGPT usage limit. Try again at: May 31st, 2026 8:34 AM.");
    assert.equal(
      r.suggestion,
      "Wait for ChatGPT limits to reset, or switch to a profile that does not use ChatGPT. ChatGPT limits are separate from Interpreter credits shown in Settings > Plan.",
    );
  });

  test("chatgpt_usage_limit_sentence_without_contraction_uses_interpreter_copy", () => {
    const detailedMessage = "You have hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at May 31st, 2026 8:34 AM.";
    const r = parseError(detailedMessage, "openai-oauth");
    assertShape(r);
    assert.equal(r.type, "provider_usage_limit");
    assert.equal(r.title, "ChatGPT usage limit reached");
    assert.equal(r.message, "You've hit your ChatGPT usage limit. Try again at: May 31st, 2026 8:34 AM.");
  });

  test("hosted_account_inactive_billing_error_returns_provider_account_copy", () => {
    const r = parseError(
      "stream disconnected before completion: Your account is not active, please check your billing details on our website.",
      "hosted",
    );
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Some Interpreter hosted models are temporarily unavailable.",
    );
    assert.equal(
      r.suggestion,
      "We're working on this.",
    );
  });

  test("hosted_high_demand_error_returns_infrastructure_copy", () => {
    const r = parseError(
      "We're currently experiencing high demand, which may cause temporary errors.",
      "hosted",
    );

    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Interpreter hosted models are temporarily unavailable because servers are overloaded.",
    );
    assert.equal(
      r.suggestion,
      "We're working on this.",
    );
  });

  test("hosted_high_demand_provider_message_returns_infrastructure_copy", () => {
    const r = parseError(
      "We're currently experiencing high demand, which may cause temporary errors.",
      "interpreter",
    );

    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Interpreter hosted models are temporarily unavailable because servers are overloaded.",
    );
    assert.equal(
      r.suggestion,
      "We're working on this.",
    );
  });

  test("raw_high_demand_without_hosted_provider_does_not_use_interpreter_copy", () => {
    const r = parseError(
      "We're currently experiencing high demand, which may cause temporary errors.",
      "openai-oauth",
    );

    assertShape(r);
    assert.notEqual(r.title, "Interpreter hosted models temporarily unavailable");
  });

  test("issue_1364_wrapped_high_demand_error_returns_infrastructure_copy", () => {
    const r = parseError(
      [
        "Request failed",
        "",
        "We're currently experiencing high demand, which may cause temporary errors.",
        "",
        "Try again, or start a new conversation if the problem persists.",
      ].join("\n"),
      "hosted",
    );

    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Interpreter hosted models are temporarily unavailable because servers are overloaded.",
    );
    assert.equal(
      r.suggestion,
      "We're working on this.",
    );
  });

  test("formatted_hosted_overloaded_error_returns_infrastructure_copy", () => {
    const r = parseError(INTERPRETER_HOSTED_OVERLOADED_MESSAGE, "hosted");

    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Interpreter hosted models are temporarily unavailable because servers are overloaded.",
    );
    assert.equal(
      r.suggestion,
      "We're working on this.",
    );
  });

  test("formatted_hosted_account_inactive_error_returns_provider_account_copy", () => {
    const r = parseError(INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE, "hosted");

    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Some Interpreter hosted models are temporarily unavailable.",
    );
    assert.equal(
      r.suggestion,
      "We're working on this.",
    );
  });

  test("issue_1247_wrapped_hosted_account_inactive_error_returns_provider_account_copy", () => {
    const r = parseError(
      [
        "Request failed",
        "",
        "stream disconnected before completion: Your account is not active, please check your billing details on our website.",
        "",
        "Try again, or start a new conversation if the problem persists.",
      ].join("\n"),
      "hosted",
    );
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Some Interpreter hosted models are temporarily unavailable.",
    );
    assert.equal(
      r.suggestion,
      "We're working on this.",
    );
  });

  test("issue_1248_retry_details_format_and_parse_as_provider_account_copy", () => {
    const formatted = formatTurnError(
      {
        message: "Reconnecting... 5/5",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: "stream disconnected before completion: Your account is not active, please check your billing details on our website.",
      },
      { modelProvider: "interpreter", providerLabel: "Interpreter Smart" },
    );
    const r = parseError(formatted, "hosted");
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Some Interpreter hosted models are temporarily unavailable.",
    );
  });

  test("local_account_inactive_billing_error_does_not_use_hosted_copy", () => {
    const r = parseError(
      "stream disconnected before completion: Your account is not active, please check your billing details on our website.",
      "ollama",
    );
    assertShape(r);
    assert.notEqual(r.title, "Interpreter hosted models temporarily unavailable");
  });

  test("quota_exceeded_returns_provider_usage_limit", () => {
    const r = parseError("Quota exceeded for this billing period");
    assertShape(r);
    assert.equal(r.type, "provider_usage_limit");
  });

  test("billing_hard_limit_returns_provider_usage_limit", () => {
    const r = parseError("billing hard limit reached");
    assertShape(r);
    assert.equal(r.type, "provider_usage_limit");
  });

  test("usage_limit_has_been_reached_returns_provider_usage_limit", () => {
    const r = parseError("Your usage limit has been reached");
    assertShape(r);
    assert.equal(r.type, "provider_usage_limit");
  });

  test("payment_required_insufficient_tokens_returns_provider_error", () => {
    const r = parseError('unexpected status 402 Payment Required: {"error":{"detail":"Insufficient tokens"}}');
    assertShape(r);
    assert.equal(r.type, "provider_error");
    assert.equal(r.title, "Provider payment error");
    assert.equal(r.suggestion, "This may be temporary. Try again, or switch provider/profile.");
  });

  test("payment_required_openrouter_generic_402_returns_provider_error", () => {
    const r = parseError("unexpected status 402 Payment Required, url: https://hosted.example.test/v0/openrouter/responses");
    assertShape(r);
    assert.equal(r.type, "provider_error");
    assert.equal(r.title, "Provider payment error");
    assert.equal(r.message, "A model provider returned a payment-required response.");
    assert.equal(r.suggestion, "This may be temporary. Try again, or switch provider/profile.");
  });

  test("payment_required_openrouter_generic_402_returns_provider_specific_copy_when_provider_is_present", () => {
    const r = parseError("unexpected status 402 Payment Required, url: https://hosted.example.test/v0/openrouter/responses", "hosted");
    assertShape(r);
    assert.equal(r.type, "provider_error");
    assert.equal(r.title, "Interpreter payment error");
    assert.equal(r.message, "Interpreter returned a payment-required response.");
    assert.equal(r.suggestion, "This may be temporary. Try again, or switch to a profile that does not use Interpreter.");
  });

  test("payment_required_openrouter_with_explicit_user_credit_signal_returns_interpreter_credits_exhausted", () => {
    const r = parseError(
      "unexpected status 402 Payment Required: [not_enough_tokens]: User has insufficient interpreter tokens, url: https://hosted.example.test/v0/openrouter/responses",
      undefined,
      undefined,
      true,
    );
    assertInterpreterCreditsExhausted(r, "paid");
  });

  test("formatted_insufficient_interpreter_tokens_message_returns_interpreter_credits_exhausted", () => {
    const r = parseError("Insufficient interpreter tokens. Add tokens in billing settings.");
    assertInterpreterCreditsExhausted(r);
  });

  test("content_filtering_policy_error_returns_content_filter", () => {
    const raw = "Output blocked by content filtering policy";
    const r = parseError(raw);
    assertShape(r);
    assert.equal(r.type, "content_filter");
    assert.equal(r.title, "Blocked by content policy");
    assert.equal(r.message, raw);
    assert.equal(r.suggestion, "Try rephrasing your request, reducing included source material, or starting a new conversation.");
  });

  test("array_above_max_length_returns_fresh_thread_required", () => {
    const r = parseError("{\"error\":{\"message\":\"Invalid 'input[4].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.\",\"type\":\"invalid_request_error\",\"param\":\"input[4].content\",\"code\":\"array_above_max_length\"}}");
    assertShape(r);
    assert.equal(r.type, "fresh_thread_required");
    assert.equal(r.title, "This chat needs a fresh thread");
  });

  test("rate_limit_string_returns_rate_limit", () => {
    const r = parseError("Rate limit exceeded");
    assertShape(r);
    assert.equal(r.type, "rate_limit");
  });

  test("rate_limit_string_with_provider_uses_provider_name_in_title", () => {
    const r = parseError("Rate limited. Try again later.", "groq");
    assertShape(r);
    assert.equal(r.type, "rate_limit");
    assert.equal(r.title, "Too many requests to Groq");
  });

  test("429_in_string_returns_rate_limit", () => {
    const r = parseError("Error 429: too many requests");
    assertShape(r);
    assert.equal(r.type, "rate_limit");
  });

  test("failed_to_fetch_returns_network", () => {
    const r = parseError("Failed to fetch");
    assertShape(r);
    assert.equal(r.type, "network");
  });

  test("fetch_failed_returns_network", () => {
    const r = parseError("fetch failed");
    assertShape(r);
    assert.equal(r.type, "network");
  });

  test("fetch_error_returns_network", () => {
    const r = parseError("fetch error: connection reset");
    assertShape(r);
    assert.equal(r.type, "network");
  });

  test("network_error_returns_network", () => {
    const r = parseError("Network error");
    assertShape(r);
    assert.equal(r.type, "network");
  });

  test("timeout_returns_network", () => {
    const r = parseError("Request timeout after 30s");
    assertShape(r);
    assert.equal(r.type, "network");
  });

  test("500_server_error_string_returns_server", () => {
    const r = parseError("HTTP 500 server error");
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("internal_server_error_returns_server", () => {
    const r = parseError("Internal server error");
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("internal_error_returns_server", () => {
    const r = parseError("Internal error occurred");
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("invalid_model_with_groq_provider_uses_provider_specific_suggestion", () => {
    const r = parseError("invalid model", "groq");
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(
      r.suggestion,
      "Check the model ID in Settings > Models for your Groq profile.",
    );
  });

  test("server_error_string_returns_server", () => {
    const r = parseError("A server error occurred");
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("503_interpreter_models_unavailable_returns_service_unavailable", () => {
    const r = parseError('unexpected status 503 Service Unavailable: {"error":{"detail":"Interpreter models temporarily unavailable"}}, url: http://localhost:8000/v0/openrouter/responses');
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Models temporarily unavailable");
    assert.ok(
      !r.message.includes("url:") && !r.message.includes("localhost"),
      "Must not leak internal URLs to the user",
    );
  });

  test("503_generic_returns_service_unavailable", () => {
    const r = parseError("unexpected status 503 Service Unavailable");
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.message, "Interpreter hosted models are temporarily unavailable.");
  });

  test("503_local_endpoint_url_without_provider_returns_local_service_unavailable", () => {
    const r = parseError(
      "unexpected status 503 Service Unavailable: Unknown error, url: http://localhost:11434/v1/responses",
    );
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Ollama temporarily unavailable");
    assert.equal(r.message, "The Ollama server returned a temporary service-unavailable response.");
  });

  test("503_local_provider_with_lmstudio_endpoint_returns_lmstudio_service_unavailable", () => {
    const r = parseError(
      { status: 503 },
      "local",
      undefined,
      undefined,
      "http://localhost:1234/v1",
    );
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "LM Studio temporarily unavailable");
    assert.equal(r.message, "The LM Studio local server returned a temporary service-unavailable response.");
  });

  test("502_bad_gateway_string_returns_server", () => {
    const r = parseError("HTTP 502 Bad Gateway");
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("nkeep_nctx_returns_local_context_too_small", () => {
    const r = parseError("The number of tokens to keep from the initial prompt is greater than the context length (n_keep: 7248>= n_ctx: 4096)");
    assertShape(r);
    assert.equal(r.type, "local_context_too_small");
  });

  test("load_model_larger_context_returns_local_context_too_small", () => {
    const r = parseError("Try to load the model with a larger context length, or provide a shorter input.");
    assertShape(r);
    assert.equal(r.type, "local_context_too_small");
  });

  test("local_context_too_small_takes_priority_over_context_overflow", () => {
    const r = parseError("context length error: n_keep: 7248>= n_ctx: 4096");
    assertShape(r);
    assert.equal(r.type, "local_context_too_small");
  });

  test("stream_disconnect_on_local_provider_returns_local_context_too_small", () => {
    const r = parseError(
      "stream disconnected before completion: stream closed before response.completed",
      "local",
    );
    assertShape(r);
    assert.equal(r.type, "local_context_too_small");
  });

  test("stream_disconnect_on_non_local_provider_returns_unknown", () => {
    const r = parseError(
      "stream disconnected before completion: stream closed before response.completed",
      "hosted",
    );
    assertShape(r);
    assert.notEqual(r.type, "local_context_too_small");
  });

  test("hosted_internal_stream_disconnect_returns_infrastructure_copy", () => {
    const formatted = formatTurnError(
      {
        message: "stream disconnected before completion: internal stream ended unexpectedly",
        codexErrorInfo: "other",
        additionalDetails: null,
      },
      { modelProvider: "interpreter", providerLabel: "Hosted" },
    );

    const r = parseError(formatted, "hosted");
    assertShape(r);
    assert.equal(r.type, "service_unavailable");
    assert.equal(r.title, "Interpreter hosted models temporarily unavailable");
    assert.equal(
      r.message,
      "Interpreter hosted models are temporarily unavailable because servers are overloaded.",
    );
    assert.equal(
      r.suggestion,
      "We're working on this.",
    );
  });

  test("raw_hosted_internal_stream_disconnect_returns_actionable_provider_error", () => {
    const r = parseError(
      "stream disconnected before completion: internal stream ended unexpectedly",
      "hosted",
    );
    assertShape(r);
    assert.equal(r.type, "provider_stream_disconnected");
  });

  test("raw_internal_stream_disconnect_without_provider_remains_unknown", () => {
    const r = parseError(
      "stream disconnected before completion: internal stream ended unexpectedly",
    );
    assertShape(r);
    assert.equal(r.type, "unknown");
  });

  test("stream_disconnect_without_provider_does_not_match_local_heuristic", () => {
    const r = parseError(
      "stream disconnected before completion: stream closed before response.completed",
    );
    assertShape(r);
    assert.notEqual(r.type, "local_context_too_small");
  });

  test("context_window_exceeded_on_lmstudio_returns_local_context_too_small", () => {
    const r = parseError(
      "Context window exceeded. Start a new conversation.",
      "lmstudio",
    );
    assertShape(r);
    assert.equal(r.type, "local_context_too_small");
    assert.equal(r.title, "Model context length too small");
    assert.match(r.suggestion, /LM Studio/i);
    assert.match(r.suggestion, /built-in tools/i);
    assert.doesNotMatch(r.suggestion, /Ollama/i);
  });

  test("conversation_too_long_on_ollama_returns_local_context_too_small", () => {
    const r = parseError(
      "Conversation too long. The conversation exceeded the model context limit.",
      "ollama",
    );
    assertShape(r);
    assert.equal(r.type, "local_context_too_small");
    assert.match(r.suggestion, /Ollama/i);
    assert.match(r.suggestion, /built-in tools/i);
    assert.doesNotMatch(r.suggestion, /LM Studio/i);
  });

  test("too_long_returns_context_overflow", () => {
    const r = parseError("The prompt is too long for this model");
    assertShape(r);
    assert.equal(r.type, "context_overflow");
  });

  test("too_large_returns_context_overflow", () => {
    const r = parseError("Request too large");
    assertShape(r);
    assert.equal(r.type, "context_overflow");
  });

  test("context_length_returns_context_overflow", () => {
    const r = parseError("Maximum context length exceeded");
    assertShape(r);
    assert.equal(r.type, "context_overflow");
  });

  test("max_input_returns_context_overflow", () => {
    const r = parseError("Exceeds max_input tokens");
    assertShape(r);
    assert.equal(r.type, "context_overflow");
  });

  test("token_limit_returns_context_overflow", () => {
    const r = parseError("Exceeded token limit");
    assertShape(r);
    assert.equal(r.type, "context_overflow");
  });

  test("maximum_context_returns_context_overflow", () => {
    const r = parseError("Exceeded maximum context window");
    assertShape(r);
    assert.equal(r.type, "context_overflow");
  });

  test("context_overflow_preserves_raw_string_as_message", () => {
    const raw = "The prompt is too long for this model";
    const r = parseError(raw);
    assert.equal(r.message, raw);
  });

  test("anthropic_error_returns_provider_error", () => {
    const r = parseError("Anthropic API returned an unexpected error");
    assertShape(r);
    assert.equal(r.type, "provider_error");
  });

  test("openai_error_returns_provider_error", () => {
    const r = parseError("OpenAI model returned an error");
    assertShape(r);
    assert.equal(r.type, "provider_error");
  });

  test("groq_error_returns_provider_error", () => {
    const r = parseError("Groq inference engine failed");
    assertShape(r);
    assert.equal(r.type, "provider_error");
  });

  test("provider_error_preserves_raw_string_as_message", () => {
    const raw = "Anthropic API returned an unexpected error";
    const r = parseError(raw);
    assert.equal(r.message, raw);
  });

  test("nested_hosted_provider_json_extracts_deep_provider_message", () => {
    const providerMessage =
      "Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling.";
    const providerRaw = JSON.stringify({
      error: {
        code: 400,
        message: providerMessage,
        status: "INVALID_ARGUMENT",
      },
    });
    const raw = JSON.stringify({
      error: {
        detail: JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 400,
            metadata: {
              raw: providerRaw,
              provider_name: "Google AI Studio",
              is_byok: false,
            },
          },
        }),
      },
    });
    const r = parseError(raw, "interpreter");
    assertShape(r);
    assert.equal(r.type, "provider_error");
    assert.equal(r.title, "Provider error");
    assert.equal(r.message, providerMessage);
  });

  test("random_string_returns_unknown", () => {
    const raw = "something completely random happened";
    const r = parseError(raw);
    assertShape(r);
    assert.equal(r.type, "unknown");
    assert.equal(r.message, raw);
  });
});

// ---------------------------------------------------------------------------
// 3. Edge cases
// ---------------------------------------------------------------------------

describe("parseError / edge cases", () => {
  test("null_input_returns_unknown", () => {
    const r = parseError(null);
    assertShape(r);
    assert.equal(r.type, "unknown");
  });

  test("empty_string_returns_unknown", () => {
    const r = parseError("");
    assertShape(r);
    assert.equal(r.type, "unknown");
  });

  test("empty_object_returns_unknown", () => {
    const r = parseError({});
    assertShape(r);
    assert.equal(r.type, "unknown");
  });

  test("object_with_message_field_falls_through_to_string_matching", () => {
    // Object has no status/type fields but has a message that matches a pattern
    const r = parseError({ message: "Rate limit exceeded" });
    assertShape(r);
    assert.equal(r.type, "rate_limit");
  });

  test("object_with_error_field_falls_through_to_string_matching", () => {
    const r = parseError({ error: "Internal server error" });
    assertShape(r);
    assert.equal(r.type, "server");
  });

  test("provider_string_with_unauthorized_returns_auth_not_provider_error", () => {
    // "openai" + "unauthorized" should match auth before provider_error
    const r = parseError("OpenAI returned unauthorized");
    assertShape(r);
    assert.equal(r.type, "auth");
  });

  test("unauthorized_with_openai_oauth_provider_returns_auth", () => {
    const r = parseError(
      "unexpected status 401 Unauthorized: Missing Bearer authentication in header",
      "openai-oauth",
    );
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "ChatGPT authentication failed");
    assert.equal(r.message, "The request was not authorized.");
  });

  test("generic_authentication_error_with_openai_oauth_provider_returns_auth", () => {
    const r = parseError(
      "Authentication failed. Check your API key, or sign in again if using hosted models.",
      "openai-oauth",
    );
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "ChatGPT authentication failed");
    assert.equal(r.message, "The request was not authorized.");
    assert.equal(r.suggestion, "Sign in with ChatGPT again in Settings > Profiles.");
  });

  test("provider_string_with_not_connected_returns_auth_provider_variant", () => {
    // "openai" + "not connected" should match auth provider variant, not provider_error
    const r = parseError("OpenAI is not connected");
    assertShape(r);
    assert.equal(r.type, "auth");
    assert.equal(r.title, "Provider not connected");
  });

  test("codex_crash_with_401_unauthorized_returns_auth_with_specific_message", () => {
    const r = parseError(
      'codex app-server exited (null): Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_invalidated","message":"Your refresh token has been invalidated. Please try signing in again."}}',
    );
    assertShape(r);
    assert.equal(r.type, "chatgpt_session_expired");
    assert.ok(r.title.includes("session expired"));
    assert.equal(r.suggestion, "Sign in again to continue.");
  });

  test("codex_crash_with_authentication_token_invalidated_returns_auth", () => {
    const r = parseError(
      "codex app-server exited (1): authentication token has been invalidated",
    );
    assertShape(r);
    assert.equal(r.type, "chatgpt_session_expired");
    assert.ok(r.title.includes("session expired"));
  });

  test("codex_crash_with_sign_in_again_returns_auth", () => {
    const r = parseError(
      "codex app-server exited (null): please try signing in again",
    );
    assertShape(r);
    assert.equal(r.type, "chatgpt_session_expired");
    assert.ok(r.title.includes("session expired"));
  });

  test("codex_crash_with_websocket_403_forbidden_returns_chatgpt_session_expired", () => {
    const r = parseError(
      "codex app-server exited (null): Failed to cancel previous login server: connection timed out\nERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses",
      "openai-oauth",
    );
    assertShape(r);
    assert.equal(r.type, "chatgpt_session_expired");
    assert.ok(r.title.includes("session expired"));
    assert.equal(r.suggestion, "Sign in again to continue.");
  });

  // NOTE(victor): Manual reproduction for codex re-auth errors:
  // 1. Sign in via OpenAI OAuth (ChatGPT provider)
  // 2. Invalidate the access_token so codex is forced to refresh:
  //    python3 -c "import json; f=open('$HOME/Library/Application Support/interpreter/codex-home/auth.json'); d=json.load(f); f.close(); d['tokens']['access_token']='invalid'; f=open('$HOME/Library/Application Support/interpreter/codex-home/auth.json','w'); json.dump(d,f); f.close()"
  // 3. Revoke the refresh token: ChatGPT Settings > Security > "Log out all"
  // 4. Send a message -- codex retries websocket (5x 500), falls back to HTTPS,
  //    then gets 401 refresh_token_invalidated on the turn (not a process crash).
  // 5. The access_token has a 10-day TTL (self-contained JWT), so step 2 is
  //    required to force an immediate refresh attempt. Without it, the error
  //    won't surface until the token naturally expires.
  test("codex_turn_error_refresh_token_revoked_returns_openai_session_expired", () => {
    const r = parseError(
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
    );
    assertShape(r);
    assert.equal(r.type, "chatgpt_session_expired");
    assert.ok(r.title.includes("session expired"));
    assert.equal(r.suggestion, "Sign in again to continue.");
  });

  test("codex_turn_error_refresh_token_already_used_returns_chatgpt_session_expired", () => {
    const r = parseError(
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    );
    assertShape(r);
    assert.equal(r.type, "chatgpt_session_expired");
    assert.ok(r.title.includes("session expired"));
    assert.equal(r.suggestion, "Sign in again to continue.");
  });

  test("codex_turn_error_access_token_could_not_be_refreshed_returns_session_expired", () => {
    const r = parseError(
      "Your access token could not be refreshed. Please log out and sign in again.",
    );
    assertShape(r);
    assert.equal(r.type, "chatgpt_session_expired");
    assert.ok(r.title.includes("session expired"));
  });

  test("codex_turn_error_object_with_codexErrorInfo_unauthorized_returns_openai_session_expired", () => {
    const r = parseError({
      message: "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      codexErrorInfo: "unauthorized",
      additionalDetails: null,
    });
    assertShape(r);
    assert.equal(r.type, "chatgpt_session_expired");
    assert.ok(r.title.includes("session expired"));
    assert.equal(r.suggestion, "Sign in again to continue.");
  });
});

// ---------------------------------------------------------------------------
// 4. Interpreter token exhaustion copy
// ---------------------------------------------------------------------------

describe("interpreter token exhaustion copy", () => {
  test("free plan message is specific", () => {
    const message = buildInterpreterCreditsExhaustedMessage("free");
    assert.equal(
      message,
      "You've exhausted your free Interpreter tokens.",
    );
  });

  test("paid plan message is specific", () => {
    const message = buildInterpreterCreditsExhaustedMessage("paid");
    assert.equal(
      message,
      "You've exhausted the Interpreter tokens included with this plan.",
    );
  });

  test("paid plan message includes refresh date when available", () => {
    const message = buildInterpreterCreditsExhaustedMessage("paid", "April 30, 2026");
    assert.equal(
      message,
      "You've exhausted the Interpreter tokens included with this plan. Your included usage refreshes on April 30, 2026.",
    );
  });

  test("suggestion stays focused on upgrade or custom provider", () => {
    const suggestion = buildInterpreterCreditsExhaustedSuggestion("paid");
    assert.equal(
      suggestion,
      "Upgrade for more included usage, or switch to a custom provider to keep using Interpreter.",
    );
  });

  test("card copy follows active locale while parser receives stable error", async () => {
    await i18n.changeLanguage("ru");

    try {
      const result = parseError("Insufficient interpreter tokens. Add tokens in billing settings.");

      assert.equal(result.type, "interpreter_credits_exhausted");
      assert.equal(result.title, "Токены Interpreter исчерпаны");
      assert.equal(result.message, "Вы исчерпали токены Interpreter, доступные для этой учётной записи.");
      assert.equal(
        result.suggestion,
        "Перейдите на план с большим включённым использованием или переключитесь на пользовательского провайдера, чтобы продолжить использовать Interpreter.",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Return value structure
// ---------------------------------------------------------------------------

describe("parseError / return value structure", () => {
  const inputs: Array<{ label: string; input: Parameters<typeof parseError>[0] }> = [
    { label: "rate_limit (status)", input: { status: 429 } },
    { label: "auth (status)", input: { status: 401 } },
    { label: "server (status)", input: { status: 500 } },
    { label: "rate_limit (type)", input: { type: "rate_limit_error" } },
    { label: "claude_code_not_installed", input: "claude not installed" },
    { label: "acp_not_available", input: "acp spawn failed" },
    { label: "ollama_not_running", input: "ollama is not running" },
    { label: "ollama_model_missing", input: "model 'x' not found" },
    { label: "local_model_no_tools", input: "model does not support tools" },
    { label: "lmstudio_backend_error", input: "Failed to load LLM engine: llm_engine_mlx.node. dlopen failed" },
    { label: "lmstudio_no_models", input: "No models loaded. Please load a model in the developer page or use the 'lms load' command." },
    { label: "auth (provider)", input: "provider is not connected" },
    { label: "auth (unauthorized)", input: "unauthorized" },
    { label: "session_expired", input: "session expired" },
    { label: "provider_usage_limit", input: "usage limit reached" },
    { label: "interpreter_credits_exhausted", input: "[not_enough_tokens]: User has insufficient interpreter tokens" },
    { label: "content_filter", input: "Output blocked by content filtering policy" },
    { label: "rate_limit (string)", input: "rate limit exceeded" },
    { label: "network", input: "failed to fetch" },
    { label: "server (string)", input: "internal server error" },
    { label: "context_overflow", input: "prompt too long" },
    { label: "provider_error", input: "anthropic returned an error" },
    { label: "unknown", input: "some random error" },
    { label: "null", input: null },
  ];

  for (const { label, input } of inputs) {
    test(`${label}_has_valid_shape`, () => {
      const r = parseError(input);
      assert.equal(typeof r.type, "string");
      assert.equal(typeof r.title, "string");
      assert.equal(typeof r.message, "string");
      assert.equal(typeof r.suggestion, "string");
      assert.ok(r.type.length > 0, `type must be non-empty for ${label}`);
      assert.ok(r.title.length > 0, `title must be non-empty for ${label}`);
      assert.ok(r.message.length > 0, `message must be non-empty for ${label}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Invalid model ID errors
// ---------------------------------------------------------------------------

describe("parseError / invalid model ID", () => {
  test("raw_json_string_with_not_a_valid_model_extracts_message_and_provider", () => {
    const r = parseError('{"error":{"message":"qwen3.5:9b is not a valid model ID","code":400},"user_id":"user_abc123"}', "hosted");
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(r.title, "Invalid Interpreter model ID");
    assert.equal(r.message, "qwen3.5:9b is not a valid model ID");
    assert.equal(
      r.suggestion,
      "Check the model ID in Settings > Models for your Interpreter profile. Hosted model IDs must be `interpreter-smart`, `interpreter-fast`, or `<provider>/<model_id>`.",
    );
  });

  test("plain_string_invalid_model_uses_provider_name", () => {
    const r = parseError("not a valid model ID", "api");
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(r.title, "Invalid API provider model ID");
  });

  test("invalid_model_without_provider_uses_fallback", () => {
    const r = parseError("Invalid model: xyz");
    assertShape(r);
    assert.equal(r.type, "invalid_model");
    assert.equal(r.title, "Invalid Provider model ID");
  });

  test("unknown_error_with_json_string_extracts_message", () => {
    const r = parseError('{"error":{"message":"Something unexpected happened","code":418}}');
    assertShape(r);
    assert.equal(r.message, "Something unexpected happened");
  });

  test("unknown_empty_payload_does_not_show_unexpected_error_copy", () => {
    const r = parseError({});
    assertShape(r);
    assert.equal(r.type, "unknown");
    assert.equal(
      r.message,
      "Interpreter did not receive a readable error message for this failed request.",
    );
  });
});

describe("shouldShowProfileSwitchWarning", () => {
  test("does not show warning for provider errors after profile switch", () => {
    assert.equal(shouldShowProfileSwitchWarning(true, "provider_error"), false);
  });

  test("shows warning for fresh thread errors after profile switch", () => {
    assert.equal(shouldShowProfileSwitchWarning(true, "fresh_thread_required"), true);
  });

  test("does not show warning for generic server errors", () => {
    assert.equal(shouldShowProfileSwitchWarning(true, "server"), false);
  });

  test("does not show warning when profile switch flag is false", () => {
    assert.equal(shouldShowProfileSwitchWarning(false, "provider_error"), false);
  });
});
