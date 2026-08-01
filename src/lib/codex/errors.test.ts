import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import type { v2 } from "@/schemas";
import {
  classifyToolOutcome,
  formatTurnError,
  getResponsesToolCallingContractError,
  INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE,
  INTERPRETER_HOSTED_OVERLOADED_MESSAGE,
  isFailedToolItem,
} from "./errors";

const REAL_402_NOT_ENOUGH_TOKENS_PAYLOAD =
  'unexpected status 402 Payment Required: {"error":{"detail":"[not_enough_tokens]: Insufficient interpreter tokens"}}';
const REAL_413_GROQ_TPM_PAYLOAD =
  "unexpected status 413 Payload Too Large: Request too large for model `openai/gpt-oss-120b` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 20525, please reduce your message size and try again.";
const EXPECTED_REQUEST_TOO_LARGE_MESSAGE =
  "This request is too large for the selected model's current token limit. Reduce the message or context, then try again.";
const LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR =
  'stream disconnected before completion: Error rendering prompt with jinja template: "This model only supports single tool-calls at once!". This is usually an issue with the model\'s chat template.';
const LMSTUDIO_OTHER_TEMPLATE_ERROR =
  'stream disconnected before completion: Error rendering prompt with jinja template: "Template variable tools is undefined".';
const EXPECTED_LMSTUDIO_TOOL_SUPPORT_GUIDANCE = [
  LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR,
  "",
  "The selected model from LM Studio doesn't support Interpreter tools.",
  "Choose a tool-capable model in LM Studio, or switch to an Interpreter hosted model, then retry.",
].join("\n");
const REAL_NESTED_GEMINI_PARTS_ERROR = JSON.stringify({
  error: {
    detail: JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              code: 400,
              message:
                "Unable to submit request because it must include at least one parts field, which describes the prompt input. Learn more: https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/gemini",
              status: "INVALID_ARGUMENT",
            },
          }),
          provider_name: "Google",
          is_byok: false,
        },
      },
      user_id: "user_32qMOZxAy7qpgBADYrm3tQ4BYe9",
    }),
  },
});
const REAL_NESTED_GEMINI_TOOL_CONFIG_ERROR = JSON.stringify({
  error: {
    detail: JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              code: 400,
              message:
                "Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling.",
              status: "INVALID_ARGUMENT",
            },
          }),
          provider_name: "Google AI Studio",
          is_byok: false,
        },
      },
      user_id: "user_32qMOZxAy7qpgBADYrm3tQ4BYe9",
    }),
  },
});

function makeTurnError(
  message: string,
  codexErrorInfo: v2.CodexErrorInfo | null = null,
  additionalDetails: string | null = null,
): v2.TurnError {
  return { message, codexErrorInfo, additionalDetails };
}

describe("formatTurnError", () => {
  test("should_return_friendly_message_when_unauthorized", () => {
    const result = formatTurnError(makeTurnError("raw", "unauthorized"));
    assert.equal(
      result,
      "Authentication failed. Check your API key, or sign in again if using hosted models.",
    );
  });

  test("should_explain_chatgpt_sign_in_when_unauthorized_refresh_token_error_uses_chatgpt_profile", () => {
    for (const msg of [
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "Your access token could not be refreshed. Please log out and sign in again.",
    ]) {
      const result = formatTurnError(
        makeTurnError(msg, "unauthorized"),
        { isChatGptProfile: true },
      );
      assert.equal(
        result,
        "Your ChatGPT sign-in expired. Sign in with ChatGPT again in Settings > Models, then retry.",
        `should clarify ChatGPT sign-in for: ${msg.slice(0, 50)}...`,
      );
    }
  });

  test("should_explain_selected_provider_sign_in_when_unauthorized_refresh_token_error_has_no_chatgpt_context", () => {
    for (const msg of [
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "refresh_token_reused",
    ]) {
      const result = formatTurnError(makeTurnError(msg, "unauthorized"));
      assert.equal(
        result,
        "Authentication failed. Sign in again with the selected model provider, then retry.",
        `should clarify selected provider sign-in for: ${msg.slice(0, 50)}...`,
      );
    }
  });

  test("should_prompt_sign_in_when_unauthorized_session_is_expired_or_invalid", () => {
    const expected =
      "Authentication failed. Your session expired. Please sign in again.";

    for (const details of [
      'unexpected status 401 Unauthorized: {"error":{"detail":{"code":"AUTH_SESSION_EXPIRED","message":"Your hosted session has expired."}}}',
      '{"error":{"detail":{"code":"AUTH_SESSION_INVALID","message":"Your hosted session is invalid."}}}',
      '{"code":"AUTH_SESSION_EXPIRED"}',
    ]) {
      assert.equal(
        formatTurnError(makeTurnError("raw", "unauthorized", details)),
        expected,
        `should detect session error in: ${details.slice(0, 40)}...`,
      );
    }
  });

  test("should_keep_generic_auth_message_when_unauthorized_has_no_structured_code", () => {
    const generic =
      "Authentication failed. Check your API key, or sign in again if using hosted models.";

    for (const details of [
      "unexpected status 401 Unauthorized: Session from session_id claim in JWT does not exist",
      "AUTH_SESSION_EXPIRED_V2",
      "XAUTH_SESSION_EXPIRED",
      null,
      "",
    ]) {
      assert.equal(
        formatTurnError(makeTurnError("raw", "unauthorized", details)),
        generic,
        `should be generic for details: ${JSON.stringify(details)}`,
      );
    }
  });

  test("should_return_friendly_message_when_usage_limit_exceeded", () => {
    const result = formatTurnError(makeTurnError("raw", "usageLimitExceeded"));
    assert.equal(
      result,
      "Usage limit exceeded on your provider account. Try again later.",
    );
  });

  test("should_map_chatgpt_account_unsupported_model_to_profile_settings_guidance", () => {
    const result = formatTurnError(
      makeTurnError(
        "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
        "other",
      ),
    );
    assert.equal(
      result,
      'Model "gpt-5.1-codex-max" is not available on your current plan. Change your model in profile settings.',
    );
  });

  test("should_return_friendly_message_when_cyber_policy_flagged", () => {
    const result = formatTurnError(
      makeTurnError("raw", "cyberPolicy" as v2.CodexErrorInfo),
    );
    assert.equal(
      result,
      "This chat was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber",
    );
  });

  test("should_include_window_duration_and_reset_time_when_usage_limit_details_exist", () => {
    const additionalDetails = JSON.stringify({
      rateLimitsByLimitId: {
        codex: {
          primary: {
            usedPercent: 100,
            windowDurationMins: 180,
            resetsAt: 1742428800,
          },
        },
      },
    });

    const result = formatTurnError(
      makeTurnError("raw", "usageLimitExceeded", additionalDetails),
    );
    assert.equal(
      result,
      "Usage limit exceeded on your provider account. Window: 180 minutes. Resets at: 2025-03-20T00:00:00Z.",
    );
  });

  test("should_return_interpreter_chatgpt_usage_limit_copy_when_chatgpt_account_context_is_available", () => {
    const message =
      "Error running remote compact task: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Mar 28th, 2026 1:52 PM.";
    const result = formatTurnError(
      makeTurnError(message, "usageLimitExceeded", null),
      { isChatGptProfile: true },
    );
    assert.equal(
      result,
      "You've hit your ChatGPT usage limit. Try again at: Mar 28th, 2026 1:52 PM. This limit is set by your ChatGPT account and is separate from Interpreter plan usage shown in Settings.",
    );
  });

  test("should_sanitize_issue_1360_chatgpt_plus_usage_limit_copy", () => {
    const message =
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at May 31st, 2026 8:34 AM.";
    const result = formatTurnError(
      makeTurnError(message, "usageLimitExceeded", null),
      { isChatGptProfile: true },
    );
    assert.equal(
      result,
      "You've hit your ChatGPT usage limit. Try again at: May 31st, 2026 8:34 AM. This limit is set by your ChatGPT account and is separate from Interpreter plan usage shown in Settings.",
    );
  });

  test("should_use_provider_label_when_usage_limit_context_is_available", () => {
    const result = formatTurnError(
      makeTurnError("raw", "usageLimitExceeded"),
      { modelProvider: "openrouter", providerLabel: "OpenRouter" },
    );
    assert.equal(
      result,
      "Usage limit exceeded on your OpenRouter account. Try again later.",
    );
  });

  test("should_clarify_openai_api_usage_limits_are_separate_from_chatgpt_plans", () => {
    const result = formatTurnError(
      makeTurnError(
        "Quota exceeded. Check your plan and billing details.",
        "usageLimitExceeded",
      ),
      { modelProvider: "openai-api", providerLabel: "OpenAI API" },
    );
    assert.equal(
      result,
      "Usage limit exceeded on your OpenAI API account. ChatGPT Pro and Plus do not include OpenAI API usage.",
    );
  });

  test("should_keep_generic_source_for_local_provider_usage_limit_errors", () => {
    const result = formatTurnError(
      makeTurnError("raw", "usageLimitExceeded"),
      { modelProvider: "ollama", providerLabel: "Ollama" },
    );
    assert.equal(
      result,
      "Usage limit exceeded on your provider account. Try again later.",
    );
  });

  test("should_return_friendly_message_when_context_window_exceeded", () => {
    const result = formatTurnError(
      makeTurnError("raw", "contextWindowExceeded"),
    );
    assert.equal(
      result,
      "Context window exceeded. Start a new conversation.",
    );
  });

  test("should_return_friendly_message_when_server_overloaded", () => {
    const result = formatTurnError(makeTurnError("raw", "serverOverloaded"));
    assert.equal(result, "Server overloaded. Try again later.");
  });

  test("should_return_friendly_message_when_internal_server_error", () => {
    const result = formatTurnError(
      makeTurnError("raw", "internalServerError"),
    );
    assert.equal(result, "Internal server error. Try again later.");
  });

  test("should_preserve_provider_high_demand_message_when_internal_server_error_mapping_is_generic", () => {
    const message =
      "We're currently experiencing high demand, which may cause temporary errors.";
    const result = formatTurnError(
      makeTurnError(message, "internalServerError"),
    );
    assert.equal(result, message);
  });

  test("should_preserve_provider_high_demand_message_when_structured_mapping_is_generic", () => {
    const message =
      "We're currently experiencing high demand, which may cause temporary errors.";
    const result = formatTurnError(
      makeTurnError(message, {
        responseTooManyFailedAttempts: { httpStatusCode: 500 },
      }),
    );
    assert.equal(result, message);
  });

  test("should_preserve_provider_payload_too_large_message_for_http_structured_errors", () => {
    const message =
      "unexpected status 413 Payload Too Large: Request too large for model `qwen/qwen3-32b`";
    const result = formatTurnError(
      makeTurnError(message, {
        responseTooManyFailedAttempts: { httpStatusCode: 413 },
      }),
    );
    assert.equal(result, message);
  });

  test("should_map_hosted_high_demand_details_on_stream_disconnect_to_infrastructure_copy", () => {
    const result = formatTurnError(
      makeTurnError(
        "Reconnecting... 1/5",
        { responseStreamDisconnected: { httpStatusCode: null } },
        "We're currently experiencing high demand, which may cause temporary errors.",
      ),
      { modelProvider: "interpreter", providerLabel: "Hosted" },
    );
    assert.equal(result, INTERPRETER_HOSTED_OVERLOADED_MESSAGE);
  });

  test("should_return_friendly_message_when_sandbox_error", () => {
    const result = formatTurnError(makeTurnError("raw", "sandboxError"));
    assert.equal(result, "Sandbox policy blocked this action.");
  });

  test("should_return_friendly_message_when_bad_request", () => {
    const result = formatTurnError(makeTurnError("raw", "badRequest"));
    assert.equal(result, "Bad request.");
  });

  test("should_return_friendly_message_when_thread_rollback_failed", () => {
    const result = formatTurnError(
      makeTurnError("raw", "threadRollbackFailed"),
    );
    assert.equal(result, "Failed to roll back conversation.");
  });

  test("should_fallback_to_raw_message_when_other", () => {
    const result = formatTurnError(makeTurnError("something broke", "other"));
    assert.equal(result, "something broke");
  });

  test("should_map_not_enough_tokens_marker_when_codex_error_is_other", () => {
    const result = formatTurnError(
      makeTurnError(
        REAL_402_NOT_ENOUGH_TOKENS_PAYLOAD,
        "other",
      ),
    );
    assert.equal(
      result,
      "Insufficient interpreter tokens. Add tokens in billing settings.",
    );
  });

  test("should_map_raw_payload_too_large_when_codex_error_is_other", () => {
    const result = formatTurnError(
      makeTurnError(
        REAL_413_GROQ_TPM_PAYLOAD,
        "other",
      ),
    );
    assert.equal(result, EXPECTED_REQUEST_TOO_LARGE_MESSAGE);
  });

  test("should_map_developer_role_rejection_to_ollama_update_message_when_ollama_provider", () => {
    const result = formatTurnError(
      makeTurnError(
        "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.['0].role'\"}",
        "other",
      ),
      { modelProvider: "ollama" },
    );
    assert.equal(
      result,
      "Your Ollama version does not support the required message format (developer role). Update Ollama to v0.13.4 or newer.",
    );
  });

  test("should_name_detected_ollama_version_in_developer_role_rejection_when_known", () => {
    const result = formatTurnError(
      makeTurnError(
        "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.['0].role'\"}",
        "other",
      ),
      { modelProvider: "ollama", localProviderVersion: "0.11.2" },
    );
    assert.equal(
      result,
      "Your Ollama version (v0.11.2) does not support the required message format (developer role). Update Ollama to v0.13.4 or newer.",
    );
  });

  test("should_name_outdated_ollama_when_responses_endpoint_404s_and_version_below_floor", () => {
    const result = formatTurnError(
      makeTurnError(
        "Response stream failed to connect",
        { responseStreamConnectionFailed: { httpStatusCode: 404 } },
        "unexpected status 404 Not Found from http://localhost:11434/v1/responses: 404 page not found",
      ),
      { modelProvider: "ollama", localProviderVersion: "0.12.11" },
    );
    assert.equal(
      result,
      "Your Ollama version (v0.12.11) does not support the required message format (developer role). Update Ollama to v0.13.4 or newer.",
    );
  });

  test("should_name_outdated_ollama_from_raw_responses_404_message_when_version_below_floor", () => {
    const result = formatTurnError(
      makeTurnError(
        "unexpected status 404 Not Found from /v1/responses: 404 page not found",
        "other",
      ),
      { modelProvider: "ollama", localProviderVersion: "0.12.11" },
    );
    assert.equal(
      result,
      "Your Ollama version (v0.12.11) does not support the required message format (developer role). Update Ollama to v0.13.4 or newer.",
    );
  });

  test("should_not_claim_outdated_ollama_when_version_is_unknown", () => {
    const result = formatTurnError(
      makeTurnError(
        "Response stream failed to connect",
        { responseStreamConnectionFailed: { httpStatusCode: 404 } },
        "unexpected status 404 Not Found from http://localhost:11434/v1/responses",
      ),
      { modelProvider: "ollama" },
    );
    assert.equal(result, "API endpoint not found. Check your provider URL.");
  });

  test("should_not_mask_auth_errors_for_outdated_ollama", () => {
    const result = formatTurnError(
      makeTurnError("raw", "unauthorized"),
      { modelProvider: "ollama", localProviderVersion: "0.12.11" },
    );
    assert.equal(
      result,
      "Authentication failed. Check your API key, or sign in again if using hosted models.",
    );
  });

  test("should_not_treat_ollama_cloud_as_local_ollama_for_developer_role_rejection", () => {
    const result = formatTurnError(
      makeTurnError(
        "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.['0].role'\"}",
        "other",
      ),
      {
        modelId: "gpt-oss:20b",
        modelProvider: "ollama-cloud",
        providerLabel: "Ollama Cloud",
      },
    );
    assert.equal(
      result,
      "gpt-oss:20b on Ollama Cloud does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("should_map_developer_role_rejection_to_lmstudio_update_message_when_lmstudio_provider", () => {
    const result = formatTurnError(
      makeTurnError(
        "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.['0].role'\"}",
        "other",
      ),
      { modelProvider: "lmstudio" },
    );
    assert.equal(
      result,
      "Your LM Studio version does not support the required message format (developer role). Update LM Studio to the latest version.",
    );
  });

  test("should_map_developer_role_rejection_to_contract_message_when_no_provider_context", () => {
    const result = formatTurnError(
      makeTurnError(
        "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.['0].role'\"}",
        "other",
      ),
    );
    assert.equal(
      result,
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("should_unwrap_json_error_message_when_other", () => {
    const jsonBlob = JSON.stringify({
      error: {
        message: 'Failed to load model "google/functiongemma-270m". Error: Failed to load LLM engine from path.',
        type: "invalid_request_error",
        param: "model",
        code: null,
      },
    });
    const result = formatTurnError(makeTurnError(jsonBlob, "other"));
    assert.equal(
      result,
      'Failed to load model "google/functiongemma-270m". Error: Failed to load LLM engine from path.',
    );
  });

  test("should_unwrap_json_top_level_message_when_other", () => {
    const jsonBlob = JSON.stringify({ message: "Something went wrong" });
    const result = formatTurnError(makeTurnError(jsonBlob, "other"));
    assert.equal(result, "Something went wrong");
  });

  test("should_unwrap_json_error_message_when_codex_error_info_is_null", () => {
    const jsonBlob = JSON.stringify({
      error: {
        message: "Model not available",
        type: "invalid_request_error",
      },
    });
    const result = formatTurnError(makeTurnError(jsonBlob, null));
    assert.equal(result, "Model not available");
  });

  test("should_unwrap_nested_hosted_provider_error_message_when_other", () => {
    const result = formatTurnError(
      makeTurnError(REAL_NESTED_GEMINI_PARTS_ERROR, "other"),
    );
    assert.equal(
      result,
      "Unable to submit request because it must include at least one parts field, which describes the prompt input. Learn more: https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/gemini",
    );
  });

  test("should_unwrap_nested_hosted_provider_error_message_when_codex_error_info_is_null", () => {
    const result = formatTurnError(
      makeTurnError(REAL_NESTED_GEMINI_TOOL_CONFIG_ERROR, null),
    );
    assert.equal(
      result,
      "Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling.",
    );
  });

  test("should_map_missing_bearer_to_auth_message_when_codex_error_is_other", () => {
    const result = formatTurnError(
      makeTurnError(
        "unexpected status 401 Unauthorized: Missing Bearer [REDACTED] basic authentication in header",
        "other",
      ),
    );
    assert.equal(
      result,
      "Authentication failed. Check your API key, or sign in again if using hosted models.",
    );
  });

  test("should_map_missing_authorization_header_validation_error_to_auth_message_when_codex_error_is_other", () => {
    const result = formatTurnError(
      makeTurnError(
        '{"error":[{"type":"missing","loc":["header","authorization"],"msg":"Field required","input":null}]}',
        "other",
      ),
    );
    assert.equal(
      result,
      "Authentication failed. Check your API key, or sign in again if using hosted models.",
    );
  });

  test("should_map_refresh_token_invalidation_to_sign_in_message_when_codex_error_is_other", () => {
    const result = formatTurnError(
      makeTurnError(
        "codex app-server exited (1): refresh_token_invalidated",
        "other",
      ),
    );
    assert.equal(
      result,
      "Authentication failed. Your session expired. Please sign in again.",
    );
  });

  test("should_map_invalid_encrypted_content_to_new_conversation_guidance_when_codex_error_is_other", () => {
    const result = formatTurnError(
      makeTurnError(
        "{ \"type\": \"error\", \"error\": { \"type\": \"invalid_request_error\", \"code\": \"invalid_encrypted_content\", \"message\": \"Encrypted content organization_id did not match the target organization.\" }, \"status\": 400 }",
        "other",
      ),
    );
    assert.equal(
      result,
      "Conversation encrypted content is invalid (organization mismatch). This conversation is unrecoverable.",
    );
  });

  test("should_fallback_to_raw_message_when_codex_error_info_is_null", () => {
    const result = formatTurnError(makeTurnError("raw server msg", null));
    assert.equal(result, "raw server msg");
  });

  test("should_map_missing_bearer_to_auth_message_when_codex_error_is_null", () => {
    const result = formatTurnError(
      makeTurnError(
        "unexpected status 401 Unauthorized: Missing Bearer [REDACTED] basic authentication in header",
        null,
      ),
    );
    assert.equal(
      result,
      "Authentication failed. Check your API key, or sign in again if using hosted models.",
    );
  });

  test("should_map_missing_authorization_header_validation_error_to_auth_message_when_codex_error_is_null", () => {
    const result = formatTurnError(
      makeTurnError(
        '{"error":[{"type":"missing","loc":["header","authorization"],"msg":"Field required","input":null}]}',
        null,
      ),
    );
    assert.equal(
      result,
      "Authentication failed. Check your API key, or sign in again if using hosted models.",
    );
  });

  test("should_map_invalid_encrypted_content_to_new_conversation_guidance_when_codex_error_is_null", () => {
    const result = formatTurnError(
      makeTurnError(
        "{ \"type\": \"error\", \"error\": { \"type\": \"invalid_request_error\", \"code\": \"invalid_encrypted_content\", \"message\": \"Encrypted content organization_id did not match the target organization.\" }, \"status\": 400 }",
        null,
      ),
    );
    assert.equal(
      result,
      "Conversation encrypted content is invalid (organization mismatch). This conversation is unrecoverable.",
    );
  });

  test("should_map_custom_endpoint_validation_errors_to_responses_contract_message", () => {
    const result = formatTurnError(
      makeTurnError(
        "upstream request rejected",
        { httpConnectionFailed: { httpStatusCode: 426 } },
        'unexpected status 426 Upgrade Required: {"detail":"1 validation error for Request\\ninput\\n  Input should be a valid string"}',
      ),
    );
    assert.equal(
      result,
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("should_map_tool_type_schema_rejection_to_responses_contract_message", () => {
    const turnError = {
      message: JSON.stringify({
        error: {
          code: 400,
          message: "'type' of tool must be 'function'",
          type: "invalid_request_error",
        },
      }),
      codexErrorInfo: "other",
      additionalDetails: null,
    } satisfies v2.TurnError;

    const result = formatTurnError(turnError, {
      modelProvider: "custom",
      providerLabel: "Custom Endpoint",
    });

    assert.equal(
      result,
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("should_map_openai_custom_tool_rejection_to_actionable_model_message", () => {
    const result = formatTurnError(
      makeTurnError(
        '{ "error": { "message": "Invalid value: \'custom\'", "type": "invalid_request_error", "param": "tools", "code": "unknown_parameter" } }',
        "other",
      ),
      { modelProvider: "openai-api", providerLabel: "OpenAI API" },
    );
    assert.equal(
      result,
      "This OpenAI model does not support Interpreter's custom/freeform agent tools. Use gpt-5.4-nano, or another model that supports Responses custom tools.",
    );
  });

  test("should_map_openai_custom_tool_rejection_from_raw_provider_text", () => {
    const result = formatTurnError(
      makeTurnError(
        "unexpected status 400 Bad Request: Invalid value: 'custom'. Supported values are: 'function'. param: tools",
        "other",
      ),
      { modelProvider: "openai", providerLabel: "OpenAI" },
    );
    assert.equal(
      result,
      "This OpenAI model does not support Interpreter's custom/freeform agent tools. Use gpt-5.4-nano, or another model that supports Responses custom tools.",
    );
  });

  test("should_map_hosted_openai_custom_tool_rejection_to_actionable_model_message", () => {
    const result = formatTurnError(
      makeTurnError(
        '{ "error": { "message": "Invalid value: \'custom\'", "type": "invalid_request_error", "param": "tools", "code": "unknown_parameter" } }',
        "other",
      ),
      { modelProvider: "interpreter", providerLabel: "Hosted" },
    );
    assert.equal(
      result,
      "This OpenAI model does not support Interpreter's custom/freeform agent tools. Use gpt-5.4-nano, or another model that supports Responses custom tools.",
    );
  });

  test("should_map_openrouter_openai_custom_tool_rejection_to_actionable_model_message", () => {
    const result = formatTurnError(
      makeTurnError(
        "unexpected status 400 Bad Request: Invalid value: 'custom'. Supported values are: 'function'. param: tools",
        "other",
      ),
      { modelProvider: "openrouter", providerLabel: "OpenRouter" },
    );
    assert.equal(
      result,
      "This OpenAI model does not support Interpreter's custom/freeform agent tools. Use gpt-5.4-nano, or another model that supports Responses custom tools.",
    );
  });

  test("should_map_hosted_final_other_internal_stream_disconnect_to_infrastructure_message", () => {
    const result = formatTurnError(
      makeTurnError(
        "stream disconnected before completion: internal stream ended unexpectedly",
        "other",
      ),
      { modelProvider: "interpreter", providerLabel: "Hosted" },
    );

    assert.equal(result, INTERPRETER_HOSTED_OVERLOADED_MESSAGE);
  });

  test("should_not_map_local_other_internal_stream_disconnect", () => {
    const result = formatTurnError(
      makeTurnError(
        "stream disconnected before completion: internal stream ended unexpectedly",
        "other",
      ),
      { modelProvider: "ollama" },
    );

    assert.equal(
      result,
      "stream disconnected before completion: internal stream ended unexpectedly",
    );
  });

  test("should_append_lmstudio_guidance_without_replacing_raw_error", () => {
    const result = formatTurnError({
      message:
        'Error rendering prompt with jinja template: "No user query found in messages."',
      codexErrorInfo: null,
      additionalDetails: "local runtime returned template mismatch",
    }, {
      modelProvider: "lmstudio-5a96e840",
      providerLabel: "LM Studio",
    });

    assert.equal(
      result,
      [
        'Error rendering prompt with jinja template: "No user query found in messages."',
        "local runtime returned template mismatch",
        "",
        "The selected model from LM Studio doesn't support Interpreter tools.",
        "Choose a tool-capable model in LM Studio, or switch to an Interpreter hosted model, then retry.",
      ].join("\n"),
    );
  });

  test("should_map_lmstudio_single_tool_call_template_error_to_actionable_guidance", () => {
    const result = formatTurnError({
      message: LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR,
      codexErrorInfo: null,
      additionalDetails: null,
    }, {
      modelProvider: "lmstudio-5a96e840",
      providerLabel: "LM Studio",
    });

    assert.equal(result, EXPECTED_LMSTUDIO_TOOL_SUPPORT_GUIDANCE);
  });

  test("should_not_map_jinja_template_errors_to_lmstudio_guidance_for_other_providers", () => {
    const result = formatTurnError({
      message: LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR,
      codexErrorInfo: null,
      additionalDetails: null,
    }, {
      modelProvider: "openrouter",
      providerLabel: "OpenRouter",
    });

    assert.equal(result, LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR);
  });

  test("should_map_other_lmstudio_jinja_template_errors_to_tool_support_guidance", () => {
    const result = formatTurnError({
      message: LMSTUDIO_OTHER_TEMPLATE_ERROR,
      codexErrorInfo: null,
      additionalDetails: null,
    }, {
      modelProvider: "lmstudio-5a96e840",
      providerLabel: "LM Studio",
    });

    assert.equal(
      result,
      [
        LMSTUDIO_OTHER_TEMPLATE_ERROR,
        "",
        "The selected model from LM Studio doesn't support Interpreter tools.",
        "Choose a tool-capable model in LM Studio, or switch to an Interpreter hosted model, then retry.",
      ].join("\n"),
    );
  });

  test("should_map_lmstudio_invalid_input_union_to_responses_contract_error", () => {
    const result = formatTurnError({
      message: JSON.stringify({
        error: {
          message: "Invalid type for 'input'.",
          type: "invalid_request_error",
          param: "input",
          code: "invalid_union",
        },
      }),
      codexErrorInfo: "other",
      additionalDetails: null,
    }, {
      modelProvider: "lmstudio-5a96e840",
      providerLabel: "LM Studio",
    });

    assert.equal(
      result,
      "The selected model on LM Studio does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("issue_1320_lmstudio_invalid_input_union_after_image_maps_to_image_support_guidance", () => {
    const result = formatTurnError({
      message: JSON.stringify({
        error: {
          message: "Invalid type for 'input'.",
          type: "invalid_request_error",
          param: "input",
          code: "invalid_union",
        },
      }),
      codexErrorInfo: "other",
      additionalDetails: null,
    }, {
      hasImageInput: true,
      modelProvider: "lmstudio-5a96e840",
      providerLabel: "LM Studio",
    });

    assert.equal(
      result,
      "This model is not available through an image-capable route, so it cannot inspect screenshots or images.",
    );
  });

  test("should_keep_invalid_input_union_after_image_as_contract_error_for_other_providers", () => {
    const result = formatTurnError({
      message: JSON.stringify({
        error: {
          message: "Invalid type for 'input'.",
          type: "invalid_request_error",
          param: "input",
          code: "invalid_union",
        },
      }),
      codexErrorInfo: "other",
      additionalDetails: null,
    }, {
      hasImageInput: true,
      modelProvider: "openrouter",
      providerLabel: "OpenRouter",
    });

    assert.equal(
      result,
      "The selected model on OpenRouter does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("issue_1293_tools_index_type_rejection_maps_to_lmstudio_contract_message", () => {
    const result = formatTurnError({
      message: JSON.stringify({
        error: {
          message: "Invalid",
          type: "invalid_request_error",
          param: "tools.16.type",
          code: "invalid_string",
        },
      }),
      codexErrorInfo: "other",
      additionalDetails: null,
    }, {
      modelProvider: "lmstudio-a4fec4cc",
      providerLabel: "LM Studio",
    });

    assert.equal(
      result,
      "The selected model on LM Studio does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  // --- httpConnectionFailed with HTTP code sub-matching ---

  test("should_map_http_connection_failed_with_null_code", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: null } }),
    );
    assert.equal(result, "Connection failed.");
  });

  test("should_map_http_connection_failed_401", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 401 } }),
    );
    assert.equal(
      result,
      "Authentication failed. Check your API key, or sign in again if using hosted models.",
    );
  });

  test("should_map_http_connection_failed_402", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 402 } }),
    );
    assert.equal(result, "Payment required. Check your billing settings.");
  });

  test("should_map_http_connection_failed_402_not_enough_tokens", () => {
    const result = formatTurnError(
      makeTurnError(
        "raw",
        { httpConnectionFailed: { httpStatusCode: 402 } },
        REAL_402_NOT_ENOUGH_TOKENS_PAYLOAD,
      ),
    );
    assert.equal(
      result,
      "Insufficient interpreter tokens. Add tokens in billing settings.",
    );
  });

  test("should_map_http_connection_failed_403", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 403 } }),
    );
    assert.equal(result, "Access forbidden. Check your API key permissions.");
  });

  test("should_map_http_connection_failed_404", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 404 } }),
    );
    assert.equal(result, "API endpoint not found. Check your provider URL.");
  });

  test("should_map_http_connection_failed_404_with_custom_responses_endpoint_hint", () => {
    const result = formatTurnError(
      makeTurnError(
        "raw",
        { httpConnectionFailed: { httpStatusCode: 404 } },
        'unexpected status 404 Not Found: {"detail":"Not Found"}, url: https://api.cerebras.ai/v1/responses',
      ),
      { modelProvider: "custom", providerLabel: "Custom Endpoint" },
    );
    assert.equal(
      result,
      "API endpoint not found. This base URL may not support the OpenAI Responses API (/responses). Use a supported Responses provider URL or OpenRouter.",
    );
  });

  test("should_map_http_connection_failed_408", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 408 } }),
    );
    assert.equal(result, "Request timed out. Try again.");
  });

  test("should_map_http_connection_failed_413", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 413 } }),
    );
    assert.equal(result, EXPECTED_REQUEST_TOO_LARGE_MESSAGE);
  });

  test("should_map_http_connection_failed_429", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 429 } }),
    );
    assert.equal(result, "Rate limited. Try again later.");
  });

  test("should_map_http_connection_failed_500", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 500 } }),
    );
    assert.equal(result, "Provider internal server error.");
  });

  test("should_map_http_connection_failed_502", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 502 } }),
    );
    assert.equal(result, "Bad gateway. The provider may be down.");
  });

  test("should_map_http_connection_failed_503", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 503 } }),
    );
    assert.equal(result, "Provider service unavailable. Try again later.");
  });

  test("should_map_http_connection_failed_504", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 504 } }),
    );
    assert.equal(result, "Gateway timeout. The provider is not responding.");
  });

  test("should_map_http_connection_failed_with_unmapped_code", () => {
    const result = formatTurnError(
      makeTurnError("raw", { httpConnectionFailed: { httpStatusCode: 418 } }),
    );
    assert.equal(result, "Connection failed (HTTP 418).");
  });

  // --- responseStreamConnectionFailed ---

  test("should_map_response_stream_connection_failed_with_null_code", () => {
    const result = formatTurnError(
      makeTurnError("raw", {
        responseStreamConnectionFailed: { httpStatusCode: null },
      }),
    );
    assert.equal(result, "Response stream failed to connect.");
  });

  test("should_map_response_stream_connection_failed_402", () => {
    const result = formatTurnError(
      makeTurnError("raw", {
        responseStreamConnectionFailed: { httpStatusCode: 402 },
      }),
    );
    assert.equal(result, "Payment required. Check your billing settings.");
  });

  test("should_map_response_stream_connection_failed_402_not_enough_tokens", () => {
    const result = formatTurnError(
      makeTurnError(
        "raw",
        {
          responseStreamConnectionFailed: { httpStatusCode: 402 },
        },
        REAL_402_NOT_ENOUGH_TOKENS_PAYLOAD,
      ),
    );
    assert.equal(
      result,
      "Insufficient interpreter tokens. Add tokens in billing settings.",
    );
  });

  // --- responseStreamDisconnected ---

  test("should_map_response_stream_disconnected_with_null_code", () => {
    const result = formatTurnError(
      makeTurnError("raw", {
        responseStreamDisconnected: { httpStatusCode: null },
      }),
    );
    assert.equal(result, "Response stream disconnected.");
  });

  test("should_map_response_stream_disconnected_429", () => {
    const result = formatTurnError(
      makeTurnError("raw", {
        responseStreamDisconnected: { httpStatusCode: 429 },
      }),
    );
    assert.equal(result, "Rate limited. Try again later.");
  });

  test("should_prefer_nested_provider_message_for_generic_stream_disconnect", () => {
    const providerMessage =
      "Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling.";
    const raw = JSON.stringify({
      error: {
        detail: JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 400,
            metadata: {
              raw: JSON.stringify({
                error: {
                  code: 400,
                  message: providerMessage,
                  status: "INVALID_ARGUMENT",
                },
              }),
              provider_name: "Google AI Studio",
              is_byok: false,
            },
          },
          user_id: "user_123",
        }),
      },
    });

    const result = formatTurnError(
      makeTurnError(raw, {
        responseStreamDisconnected: { httpStatusCode: null },
      }),
    );
    assert.equal(result, providerMessage);
  });

  test("should_map_openrouter_tool_use_404_to_tool_capable_route_message", () => {
    const openRouterToolUse404 =
      'unexpected status 404 Not Found: {"error":{"detail":"{\\"error\\":{\\"message\\":\\"No endpoints found that support tool use. Try disabling \\\\\\"shell\\\\\\". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection\\",\\"code\\":404}}"}}';
    const result = formatTurnError(
      makeTurnError(
        openRouterToolUse404,
        {
          responseStreamDisconnected: { httpStatusCode: 404 },
        },
        openRouterToolUse404,
      ),
    );
    assert.equal(
      result,
      "This model is not available through a tool-capable route, so it cannot run Interpreter agent tools.",
    );
  });

  test("should_map_openrouter_image_input_404_to_image_capable_route_message", () => {
    const openRouterImageInput404 =
      'unexpected status 404 Not Found: {"error":{"detail":"{\\"error\\":{\\"message\\":\\"No endpoints found that support image input\\",\\"code\\":404}}"}}';
    const result = formatTurnError(
      makeTurnError(
        "Reconnecting... 1/5",
        {
          responseStreamDisconnected: { httpStatusCode: 404 },
        },
        openRouterImageInput404,
      ),
      {
        modelProvider: "interpreter",
        providerLabel: "Hosted",
        modelId: "interpreter-fast",
      },
    );
    assert.equal(
      result,
      "This model is not available through an image-capable route, so it cannot inspect screenshots or images.",
    );
  });

  test("should_map_final_openrouter_image_input_error_to_image_capable_route_message", () => {
    const openRouterImageInput404 =
      'unexpected status 404 Not Found: {"error":{"detail":"{\\"error\\":{\\"message\\":\\"No endpoints found that support image input\\",\\"code\\":404}}"}}';
    const result = formatTurnError(
      makeTurnError(openRouterImageInput404, "other"),
      {
        modelProvider: "interpreter",
        providerLabel: "Hosted",
        modelId: "interpreter-fast",
      },
    );
    assert.equal(
      result,
      "This model is not available through an image-capable route, so it cannot inspect screenshots or images.",
    );
  });

  test("should_map_response_stream_disconnected_401_session_expired", () => {
    const result = formatTurnError(
      makeTurnError(
        "raw",
        {
          responseStreamDisconnected: { httpStatusCode: 401 },
        },
        '{"error":{"detail":{"code":"AUTH_SESSION_INVALID","message":"Your hosted session is invalid. Please sign in again."}}}',
      ),
    );
    assert.equal(
      result,
      "Authentication failed. Your session expired. Please sign in again.",
    );
  });

  test("should_map_response_stream_disconnected_413_payload_details", () => {
    const result = formatTurnError(
      makeTurnError(
        "Reconnecting... 5/5",
        { responseStreamDisconnected: { httpStatusCode: 413 } },
        REAL_413_GROQ_TPM_PAYLOAD,
      ),
    );
    assert.equal(result, EXPECTED_REQUEST_TOO_LARGE_MESSAGE);
  });

  test("should_map_hosted_account_inactive_billing_error_to_account_inactive_message", () => {
    const result = formatTurnError(
      makeTurnError(
        "stream disconnected before completion: Your account is not active, please check your billing details on our website.",
        "other",
      ),
      { modelProvider: "interpreter", providerLabel: "Interpreter Smart" },
    );
    assert.equal(
      result,
      INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE,
    );
  });

  test("should_map_issue_1247_request_failed_wrapper_to_account_inactive_message", () => {
    const result = formatTurnError(
      makeTurnError(
        [
          "Request failed",
          "",
          "stream disconnected before completion: Your account is not active, please check your billing details on our website.",
          "",
          "Try again, or start a new conversation if the problem persists.",
        ].join("\n"),
        "other",
      ),
      { modelProvider: "interpreter", providerLabel: "Interpreter Smart" },
    );
    assert.equal(
      result,
      INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE,
    );
  });

  test("should_map_hosted_account_inactive_billing_stream_details_to_account_inactive_message", () => {
    const result = formatTurnError(
      makeTurnError(
        "Reconnecting... 5/5",
        { responseStreamDisconnected: { httpStatusCode: null } },
        "stream disconnected before completion: Your account is not active, please check your billing details on our website.",
      ),
      { modelProvider: "interpreter", providerLabel: "Hosted" },
    );
    assert.equal(
      result,
      INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE,
    );
  });

  test("should_map_final_error_with_account_inactive_additional_details_to_account_inactive_message", () => {
    const result = formatTurnError(
      makeTurnError(
        "Request failed",
        "other",
        "stream disconnected before completion: Your account is not active, please check your billing details on our website.",
      ),
      { modelProvider: "interpreter", providerLabel: "Hosted" },
    );
    assert.equal(
      result,
      INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE,
    );
  });

  test("should_not_map_account_inactive_billing_errors_for_local_providers", () => {
    const raw =
      "stream disconnected before completion: Your account is not active, please check your billing details on our website.";
    const result = formatTurnError(
      makeTurnError(raw, "other"),
      { modelProvider: "ollama" },
    );
    assert.equal(result, raw);
  });

  test("should_map_response_stream_disconnected_invalid_parameter_content_required_to_contract_error", () => {
    const result = formatTurnError(
      makeTurnError(
        "stream disconnected before completion: <400> InternalError.Algo.InvalidParameter: The content field is a required field.",
        {
          responseStreamDisconnected: { httpStatusCode: null },
        },
      ),
    );
    assert.equal(
      result,
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  // --- responseTooManyFailedAttempts ---

  test("should_map_response_too_many_failed_attempts_with_null_code", () => {
    const result = formatTurnError(
      makeTurnError("raw", {
        responseTooManyFailedAttempts: { httpStatusCode: null },
      }),
    );
    assert.equal(result, "Too many failed attempts.");
  });

  test("should_map_response_too_many_failed_attempts_503", () => {
    const result = formatTurnError(
      makeTurnError("raw", {
        responseTooManyFailedAttempts: { httpStatusCode: 503 },
      }),
    );
    assert.equal(result, "Provider service unavailable. Try again later.");
  });
});

describe("getResponsesToolCallingContractError", () => {
  test("should_not_flag_plain_text_that_only_starts_with_call_colon", () => {
    const result = getResponsesToolCallingContractError(
      'call: {"status":"ok"} is shown here as plain text, not a tool invocation.',
    );
    assert.equal(result, null);
  });

  test("should_not_flag_plain_text_when_call_colon_is_followed_by_whitespace", () => {
    const result = getResponsesToolCallingContractError(
      'call: shell{"command":"pwd"} is quoted here as plain text.',
    );
    assert.equal(result, null);
  });

  test("should_not_flag_compact_fake_tool_text_when_the_line_continues_as_prose", () => {
    const result = getResponsesToolCallingContractError(
      'call:shell{"command":"pwd"} is quoted here as plain text.',
    );
    assert.equal(result, null);
  });

  test("should_not_flag_call_colon_text_when_there_is_whitespace_before_the_brace", () => {
    const result = getResponsesToolCallingContractError(
      'call:shell {"command":"pwd"}',
    );
    assert.equal(result, null);
  });

  test("should_not_flag_fake_tool_text_when_it_is_not_on_the_first_non_empty_line", () => {
    const result = getResponsesToolCallingContractError(
      'Here is the literal syntax the provider returned:\ncall:shell{"command":"pwd"}',
    );
    assert.equal(result, null);
  });

  test("should_flag_internal_error_algo_invalid_parameter_content_required_errors", () => {
    const result = getResponsesToolCallingContractError(
      "stream disconnected before completion: <400> InternalError.Algo.InvalidParameter: The content field is a required field.",
    );
    assert.equal(
      result,
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("should_flag_tool_type_schema_rejection", () => {
    const result = getResponsesToolCallingContractError(
      JSON.stringify({
        error: {
          code: 400,
          message: "'type' of tool must be 'function'",
          type: "invalid_request_error",
        },
      }),
    );

    assert.equal(
      result,
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("should_flag_developer_role_rejection_with_ollama_context", () => {
    const result = getResponsesToolCallingContractError(
      "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.['0].role'\"}",
      null,
      { modelProvider: "ollama" },
    );
    assert.equal(
      result,
      "Your Ollama version does not support the required message format (developer role). Update Ollama to v0.13.4 or newer.",
    );
  });

  test("should_not_flag_ollama_cloud_as_local_ollama_context", () => {
    const result = getResponsesToolCallingContractError(
      "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.['0].role'\"}",
      null,
      {
        modelId: "gpt-oss:20b",
        modelProvider: "ollama-cloud",
        providerLabel: "Ollama Cloud",
      },
    );
    assert.equal(
      result,
      "gpt-oss:20b on Ollama Cloud does not support Interpreter's Responses/tool-calling contract.",
    );
  });

  test("should_flag_developer_role_rejection_with_generic_fallback", () => {
    const result = getResponsesToolCallingContractError(
      "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.['0].role'\"}",
    );
    assert.equal(
      result,
      "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
    );
  });
});

describe("isFailedToolItem", () => {
  test("should_return_true_when_command_execution_failed", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_1",
      command: "ls",
      cwd: "/tmp",
      processId: null,
      status: "failed",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: 1,
      durationMs: null,
    };
    assert.equal(isFailedToolItem(item), true);
  });

  test("should_return_true_when_command_execution_declined", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_1",
      command: "rm -rf /",
      cwd: "/tmp",
      processId: null,
      status: "declined",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    assert.equal(isFailedToolItem(item), true);
  });

  test("should_return_false_when_command_execution_completed", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_1",
      command: "ls",
      cwd: "/tmp",
      processId: null,
      status: "completed",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: 0,
      durationMs: null,
    };
    assert.equal(isFailedToolItem(item), false);
  });

  test("should_return_true_when_mcp_tool_call_failed", () => {
    const item: v2.ThreadItem = {
      type: "mcpToolCall",
      id: "mcp_1",
      server: "test-server",
      tool: "test-tool",
      status: "failed",
      arguments: {},
      result: null,
      error: { message: "tool broke" },
      durationMs: null,
    };
    assert.equal(isFailedToolItem(item), true);
  });

  test("should_return_false_when_mcp_tool_call_completed", () => {
    const item: v2.ThreadItem = {
      type: "mcpToolCall",
      id: "mcp_1",
      server: "test-server",
      tool: "test-tool",
      status: "completed",
      arguments: {},
      result: null,
      error: null,
      durationMs: null,
    };
    assert.equal(isFailedToolItem(item), false);
  });

  test("should_return_true_when_file_change_failed", () => {
    const item: v2.ThreadItem = {
      type: "fileChange",
      id: "fc_1",
      changes: [],
      status: "failed",
    };
    assert.equal(isFailedToolItem(item), true);
  });

  test("should_return_true_when_file_change_declined", () => {
    const item: v2.ThreadItem = {
      type: "fileChange",
      id: "fc_1",
      changes: [],
      status: "declined",
    };
    assert.equal(isFailedToolItem(item), true);
  });

  test("should_return_true_when_collab_agent_tool_call_failed", () => {
    const item: v2.ThreadItem = {
      type: "collabAgentToolCall",
      id: "collab_1",
      tool: "spawn" as v2.CollabAgentTool,
      status: "failed",
      senderThreadId: "thr_1",
      receiverThreadIds: [],
      prompt: null,
      agentsStates: {},
    };
    assert.equal(isFailedToolItem(item), true);
  });

  test("should_return_false_when_non_tool_item", () => {
    const item: v2.ThreadItem = {
      type: "agentMessage",
      id: "msg_1",
      text: "hello",
    };
    assert.equal(isFailedToolItem(item), false);
  });

  test("should_return_false_when_web_search_item", () => {
    const item: v2.ThreadItem = {
      type: "webSearch",
      id: "ws_1",
      query: "test",
      action: null,
    };
    assert.equal(isFailedToolItem(item), false);
  });
});

describe("classifyToolOutcome", () => {
  test("commandExecution that exited zero is completed", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_1",
      command: "ls",
      cwd: "/tmp",
      processId: null,
      status: "completed",
      commandActions: [],
      aggregatedOutput: "out",
      exitCode: 0,
      durationMs: 10,
    };
    assert.deepEqual(classifyToolOutcome(item), { kind: "completed" });
  });

  test("commandExecution that exited non-zero is nonzero_exit, NOT a real failure", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_1",
      command: "grep foo bar.txt",
      cwd: "/tmp",
      processId: null,
      status: "failed",
      commandActions: [],
      aggregatedOutput: "",
      exitCode: 1,
      durationMs: 10,
    };
    assert.deepEqual(classifyToolOutcome(item), {
      kind: "nonzero_exit",
      exitCode: 1,
    });
  });

  test("commandExecution that never produced an exit is a real failure", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_1",
      command: "do-the-thing",
      cwd: "/tmp",
      processId: null,
      status: "failed",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    assert.deepEqual(classifyToolOutcome(item), {
      kind: "real_failure",
      reason: "process_start_failed",
    });
  });

  test("commandExecution that the user declined is declined", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_1",
      command: "rm -rf /",
      cwd: "/tmp",
      processId: null,
      status: "declined",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    assert.deepEqual(classifyToolOutcome(item), { kind: "declined" });
  });

  test("mcpToolCall failure is a real failure", () => {
    const item: v2.ThreadItem = {
      type: "mcpToolCall",
      id: "mcp_1",
      server: "linear",
      tool: "search",
      arguments: {},
      status: "failed",
      result: null,
    } as unknown as v2.ThreadItem;
    assert.deepEqual(classifyToolOutcome(item), {
      kind: "real_failure",
      reason: "mcp_failed",
    });
  });
});
